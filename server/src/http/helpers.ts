import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import { AppError, badRequest, unauthorized } from '../core/errors.js';
import { verifyAccessToken } from '../auth/tokens.js';
import { lookupIdempotent, saveIdempotent } from '../core/idempotency.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

/** Достаёт и проверяет access-токен. Ставится preHandler-ом на все защищённые маршруты. */
export async function requireAuth(req: FastifyRequest): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  const payload = verifyAccessToken(header.slice(7));
  if (!payload) throw unauthorized('Сессия истекла');
  req.userId = payload.sub;
}

/** Валидация тела запроса. Неизвестные поля отбрасываются Zod-ом. */
export function parseBody<T extends ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw badRequest(
      result.error.issues[0]?.message ?? 'Некорректные данные',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

/**
 * Обёртка мутации: требует Idempotency-Key и при повторе возвращает
 * ранее сохранённый ответ вместо повторного выполнения.
 */
export async function idempotent<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  fn: () => T | Promise<T>,
  successStatus = 200,
): Promise<unknown> {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 100) {
    throw badRequest('Требуется заголовок Idempotency-Key');
  }
  const cached = lookupIdempotent(key, req.userId, req.method, req.url, req.body);
  if (cached) {
    reply.header('Idempotency-Replayed', 'true');
    reply.code(cached.statusCode);
    return cached.body;
  }
  const body = await fn();
  saveIdempotent(key, req.userId, req.method, req.url, req.body, successStatus, body);
  reply.code(successStatus);
  return body;
}

export function toHttpError(err: unknown): { statusCode: number; body: unknown } {
  if (err instanceof AppError) {
    const error: Record<string, unknown> = { code: err.code, message: err.message };
    if (err.details !== undefined) error.details = err.details;
    if ('current' in err && err.current !== undefined) error.current = (err as { current: unknown }).current;
    return { statusCode: err.statusCode, body: { error } };
  }

  // Ошибки плагинов Fastify (rate limit, слишком большое тело, битый JSON)
  // несут собственный statusCode. Без этой ветки они схлопывались бы
  // в 500 и клиент не мог бы отличить «слишком часто» от «сервер упал».
  const fastifyErr = err as { statusCode?: number; code?: string; message?: string };
  if (typeof fastifyErr.statusCode === 'number' && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
    const known: Record<number, { code: string; message: string }> = {
      429: { code: 'rate_limited', message: 'Слишком много запросов — попробуйте через минуту' },
      413: { code: 'payload_too_large', message: 'Слишком большой запрос' },
      400: { code: 'bad_request', message: 'Некорректный запрос' },
    };
    const mapped = known[fastifyErr.statusCode] ?? {
      code: (fastifyErr.code ?? 'request_error').toLowerCase(),
      message: fastifyErr.message ?? 'Некорректный запрос',
    };
    return { statusCode: fastifyErr.statusCode, body: { error: mapped } };
  }

  return {
    statusCode: 500,
    body: { error: { code: 'internal_error', message: 'Внутренняя ошибка сервера' } },
  };
}
