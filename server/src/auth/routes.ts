import type { FastifyInstance, FastifyReply } from 'fastify';
import { registerSchema, loginSchema, settingsSchema, DEFAULT_CURRENCY } from '@checkbudget/shared';
import { db } from '../db/index.js';
import { hashPassword, verifyPassword } from './password.js';
import { signAccessToken, newRefreshToken, hashToken } from './tokens.js';
import { newId, nowIso } from '../core/ids.js';
import { AppError, unauthorized, unprocessable } from '../core/errors.js';
import { config } from '../config.js';
import { requireAuth, parseBody } from '../http/helpers.js';
import { invalidateActorName } from '../core/events.js';

const REFRESH_COOKIE = 'cb_refresh';

function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: config.refreshTokenTtlSec,
  });
}

async function issueSession(userId: string, userAgent: string | undefined, familyId?: string) {
  const refresh = newRefreshToken();
  await db.run(
    `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at, user_agent, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    newId(), userId, familyId ?? newId(), hashToken(refresh),
    new Date(Date.now() + config.refreshTokenTtlSec * 1000).toISOString(),
    userAgent ?? null, nowIso(),
  );
  return { accessToken: signAccessToken(userId), refresh };
}

/**
 * Публичный профиль пользователя.
 *
 * Оба запроса идут в одной транзакции с явно объявленным актором:
 * user_settings закрыты RLS, а на путях входа и регистрации пользователь
 * ещё не прошёл проверку токена, поэтому автоматически подставить его
 * неоткуда.
 */
async function publicUser(userId: string) {
  return db.tx(async () => {
    const u = (await db.get<{ id: string; email: string; display_name: string; created_at: string }>(
      'SELECT id, email, display_name, created_at FROM users WHERE id = ?', userId,
    ))!;
    const s = (await db.get<{
      base_currency: string; display_currency: string | null; locale: string;
      theme: string; default_budget_id: string | null;
    }>('SELECT * FROM user_settings WHERE user_id = ?', userId))!;
    return {
      user: { id: u.id, email: u.email, displayName: u.display_name, createdAt: u.created_at },
      settings: {
        baseCurrency: s.base_currency,
        displayCurrency: s.display_currency,
        locale: s.locale,
        theme: s.theme,
        defaultBudgetId: s.default_budget_id,
      },
    };
  }, userId);
}

export const authRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post('/auth/register', async (req, reply) => {
    const input = parseBody(registerSchema, req.body);
    const exists = await db.get('SELECT 1 FROM users WHERE LOWER(email) = ?', input.email);
    if (exists) throw unprocessable('email_taken', 'Пользователь с таким email уже зарегистрирован');

    const id = newId();
    const ts = nowIso();
    const passwordHash = await hashPassword(input.password);

    await db.tx(async () => {
      await db.run(
        `INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
        id, input.email, passwordHash, input.displayName, ts, ts,
      );
      await db.run(
        `INSERT INTO user_settings (user_id, base_currency, locale, theme, updated_at)
         VALUES (?,?,?,?,?)`,
        id, DEFAULT_CURRENCY, 'ru-RU', 'system', ts,
      );
    }, id);   // актор — сам создаваемый пользователь: user_settings под RLS

    const { accessToken, refresh } = await issueSession(id, req.headers['user-agent']);
    setRefreshCookie(reply, refresh);
    reply.code(201);
    return { accessToken, ...(await publicUser(id)) };
  });

  app.post('/auth/login', async (req, reply) => {
    const input = parseBody(loginSchema, req.body);
    const user = await db.get<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE LOWER(email) = ?', input.email,
    );

    // Хеш проверяется даже когда пользователя нет — иначе разница во времени
    // ответа позволила бы перебором выяснить, какие email зарегистрированы.
    const dummy = '$scrypt$0$0$0$AAAA$AAAA';
    const ok = await verifyPassword(input.password, user?.password_hash ?? dummy);
    if (!user || !ok) throw unauthorized('Неверный email или пароль');

    const { accessToken, refresh } = await issueSession(user.id, req.headers['user-agent']);
    setRefreshCookie(reply, refresh);
    return { accessToken, ...(await publicUser(user.id)) };
  });

  /**
   * Ротация refresh-токена с детекцией кражи.
   *
   * Каждое обновление выдаёт новый токен и помечает старый использованным.
   * Повторное предъявление уже использованного токена означает, что копия
   * токена есть у кого-то ещё — отзывается вся семья токенов.
   */
  app.post('/auth/refresh', async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) throw unauthorized('Сессия не найдена');

    const row = await db.get<{
      id: string; user_id: string; family_id: string;
      used_at: string | null; revoked_at: string | null; expires_at: string;
    }>('SELECT * FROM refresh_tokens WHERE token_hash = ?', hashToken(token));

    if (!row) throw unauthorized('Сессия не найдена');

    if (row.used_at || row.revoked_at) {
      await db.run(
        'UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL',
        nowIso(), row.family_id,
      );
      reply.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
      throw new AppError(401, 'token_reuse', 'Сессия скомпрометирована — войдите заново');
    }
    if (row.expires_at < nowIso()) throw unauthorized('Сессия истекла');

    await db.run('UPDATE refresh_tokens SET used_at = ? WHERE id = ?', nowIso(), row.id);
    const { accessToken, refresh } = await issueSession(row.user_id, req.headers['user-agent'], row.family_id);
    setRefreshCookie(reply, refresh);
    return { accessToken, ...(await publicUser(row.user_id)) };
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (token) {
      await db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?', nowIso(), hashToken(token));
    }
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    reply.code(204);
    return null;
  });

  app.get('/me', { preHandler: requireAuth }, async (req) => await publicUser(req.userId));

  app.patch('/me/settings', { preHandler: requireAuth }, async (req) => {
    const input = parseBody(settingsSchema, req.body);
    const current = (await db.get<{
      base_currency: string; display_currency: string | null; theme: string; default_budget_id: string | null;
    }>('SELECT * FROM user_settings WHERE user_id = ?', req.userId))!;

    // defaultBudgetId проверяется на членство: иначе через настройки можно было бы
    // «прикрепить» к себе чужой бюджет и получить его id в ответах API.
    if (input.defaultBudgetId) {
      const member = await db.get(
        'SELECT 1 FROM budget_members WHERE budget_id = ? AND user_id = ?',
        input.defaultBudgetId, req.userId,
      );
      if (!member) throw unprocessable('unknown_budget', 'Бюджет недоступен');
    }

    await db.run(
      `UPDATE user_settings SET base_currency = ?, display_currency = ?, theme = ?,
                                default_budget_id = ?, updated_at = ?
        WHERE user_id = ?`,
      input.baseCurrency ?? current.base_currency,
      input.displayCurrency !== undefined ? input.displayCurrency : current.display_currency,
      input.theme ?? current.theme,
      input.defaultBudgetId !== undefined ? input.defaultBudgetId : current.default_budget_id,
      nowIso(), req.userId,
    );
    invalidateActorName(req.userId);
    return await publicUser(req.userId);
  });
};
