import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import { config } from './config.js';
import { db, databaseStats } from './db/index.js';
import { seedReference } from './db/seed.js';
import { toHttpError } from './http/helpers.js';
import { badRequest } from './core/errors.js';
import { authRoutes } from './auth/routes.js';
import { budgetRoutes } from './modules/budgets.js';
import { accountRoutes } from './modules/accounts.js';
import { categoryRoutes } from './modules/categories.js';
import { transactionRoutes } from './modules/transactions.js';
import { limitRoutes } from './modules/limits.js';
import { goalRoutes } from './modules/goals.js';
import { analyticsRoutes } from './modules/analytics.js';
import { currencyRoutes } from './modules/currencies.js';
import { attachRealtime, closeRealtime, realtimeStats, broadcast, setBudgetWatcher } from './realtime/hub.js';
import { EventFanout, FANOUT_CHANNEL } from './realtime/fanout.js';
import { setFanoutChannel } from './core/events.js';
import { purgeExpiredIdempotencyKeys } from './core/idempotency.js';
import { requestContext } from './core/context.js';
import { unitOfWork } from './core/events.js';

export async function buildApp() {
  const app = Fastify({
    logger: config.isProduction
      ? { level: 'info' }
      : { level: 'info', transport: undefined },
    // Логи не должны содержать сумм, email и токенов.
    disableRequestLogging: true,
    bodyLimit: 256 * 1024,
    trustProxy: config.isProduction,
  });

  /**
   * Пустое тело при content-type: application/json — норма, а не ошибка.
   * Так ведут себя многие HTTP-клиенты на DELETE-запросах, и штатный парсер
   * Fastify отвечал бы на них 400, хотя тело здесь и не требуется.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const text = String(body).trim();
      if (text === '') return done(null, undefined);
      try {
        done(null, JSON.parse(text));
      } catch {
        done(badRequest('Тело запроса не является корректным JSON'), undefined);
      }
    },
  );

  /**
   * Сжатие ответов.
   *
   * Снимок бюджета — 1,4 МБ текста, который сжимается в 73 КБ: JSON с
   * повторяющимися ключами сжимается почти двадцатикратно. На локальной
   * машине выигрыша не видно (узкое место там — процессор), но на мобильной
   * сети разница между 1,4 МБ и 73 КБ — это разница между «приложение
   * не открывается» и «открывается сразу».
   *
   * threshold отсекает мелкие ответы: тратить процессор на сжатие
   * двухсотбайтового JSON бессмысленно.
   */
  await app.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ['br', 'gzip', 'deflate'],
  });

  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: config.apiRateLimitMax,
    timeWindow: '1 minute',
    keyGenerator: (req) => (req as { userId?: string }).userId ?? req.ip,
  });

  // Контекст устанавливается один раз на запрос и виден всей его асинхронной
  // цепочке, включая запись событий в глубине сервисного слоя.
  app.addHook('onRequest', (req, _reply, done) => {
    const header = req.headers['x-client-id'];
    const clientId = typeof header === 'string' && header.length <= 64 ? header : null;
    requestContext.run({ clientId, userId: null }, done);
  });

  /**
   * Один запрос — одна транзакция.
   *
   * Обработчик оборачивается на этапе регистрации маршрута, а не вручную
   * в каждом из тридцати: ручной вариант работает ровно до первого забытого
   * места, а забытое место — это либо потерянная атомарность идемпотентности,
   * либо, в Postgres, запрос без app.user_id, который RLS молча вернёт пустым.
   *
   * Неаутентифицированные маршруты (вход, регистрация) идут мимо: актора
   * ещё нет, и они открывают транзакции сами, явно указывая пользователя.
   */
  app.addHook('onRoute', (route) => {
    const original = route.handler;
    if (typeof original !== 'function') return;
    route.handler = function wrapped(this: unknown, req, reply) {
      const userId = (req as { userId?: string }).userId;
      if (!userId) return (original as Function).call(this, req, reply);
      return unitOfWork(userId, async () => (original as Function).call(this, req, reply));
    };
  });

  app.setErrorHandler((err, req, reply) => {
    const { statusCode, body } = toHttpError(err);
    if (statusCode >= 500) req.log.error({ err }, 'unhandled error');
    reply.code(statusCode).send(body);
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Маршрут не найден' } });
  });

  app.get('/health', async () => ({
    ok: true,
    ...realtimeStats(),
    // Растущий waiting — первый признак того, что пул стал узким местом.
    db: databaseStats(),
  }));

  await app.register(
    async (api) => {
      // Вход и регистрация — самая атакуемая точка. Отдельный, куда более
      // жёсткий лимит по IP, чем у остального API.
      await api.register(async (auth) => {
        await auth.register(rateLimit, { max: config.authRateLimitMax, timeWindow: '1 minute' });
        await auth.register(authRoutes);
      });
      await api.register(currencyRoutes);
      await api.register(budgetRoutes);
      await api.register(accountRoutes);
      await api.register(categoryRoutes);
      await api.register(transactionRoutes);
      await api.register(limitRoutes);
      await api.register(goalRoutes);
      await api.register(analyticsRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}

async function main() {
  await db.migrate();
  await seedReference();

  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  attachRealtime(app.server);

  /**
   * Межинстансная рассылка событий.
   *
   * Включается только при заданном DATABASE_REPLICATION_URL. Без неё хаб
   * раздаёт события своим подписчикам напрямую — этого достаточно, пока
   * инстанс один. Как только их больше, изменение через инстанс A не дойдёт
   * до клиентов инстанса B, и приложение сломается ровно в момент
   * масштабирования.
   */
  let fanout: EventFanout | null = null;
  if (config.replicationUrl) {
    fanout = new EventFanout(config.replicationUrl, broadcast);
    await fanout.start();
    setBudgetWatcher(fanout);
    setFanoutChannel(FANOUT_CHANNEL);
    app.log.info('Межинстансная рассылка событий включена');
  }

  const cleanup = setInterval(() => void purgeExpiredIdempotencyKeys(), 3600_000);
  cleanup.unref();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      closeRealtime()
        .then(() => fanout?.close())
        .then(() => app.close())
        .then(() => db.close())
        .then(() => process.exit(0));
    });
  }

  app.log.info(`CheckBudget API: http://localhost:${config.port}  •  WS: ws://localhost:${config.port}/ws`);
}

const isEntrypoint = process.argv[1]?.includes('index.ts') || process.argv[1]?.includes('server.js');
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
