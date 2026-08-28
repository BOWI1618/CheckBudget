import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;

/**
 * Корень пакета server — ищется по package.json вверх от текущего модуля.
 *
 * Пути к БД НЕЛЬЗЯ разрешать относительно process.cwd(): `npm run dev`
 * выполняется из каталога воркспейса, а `node dist/server.js` — из корня
 * репозитория, и одно и то же относительное имя дало бы две разные базы.
 * Ошибка тихая и крайне неприятная: приложение работает, но данных нет.
 */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

const ROOT = packageRoot();

function resolveDataPath(value: string): string {
  return isAbsolute(value) ? value : resolve(ROOT, value);
}

function requiredInProduction(name: string, fallback: string): string {
  const value = env[name];
  if (value) return value;
  if (env.NODE_ENV === 'production') {
    throw new Error(`Переменная окружения ${name} обязательна в production`);
  }
  return fallback;
}

export const config = {
  nodeEnv: env.NODE_ENV ?? 'development',
  isProduction: env.NODE_ENV === 'production',
  port: Number(env.PORT ?? 3001),
  host: env.HOST ?? '0.0.0.0',
  databaseFile: resolveDataPath(env.DATABASE_FILE ?? 'data/checkbudget.db'),

  /**
   * Есть DATABASE_URL — приложение работает на PostgreSQL, нет — на SQLite.
   * Роль в этом URL не должна владеть таблицами и иметь BYPASSRLS:
   * владелец обходит RLS везде, где не включён FORCE.
   */
  databaseUrl: env.DATABASE_URL ?? null,

  /**
   * Пул соединений.
   *
   * Размер подбирается не «побольше»: каждое соединение Postgres — это
   * отдельный процесс на сервере БД, и пул больше, чем БД способна
   * обслужить, лишь переносит очередь из приложения в базу, где она хуже
   * видна. Практическое правило — (ядра БД × 2) + диски, делённое на число
   * инстансов приложения.
   */
  databasePoolSize: Number(env.DATABASE_POOL_SIZE ?? 10),

  /**
   * Сколько ждать свободного соединения. Без этого ограничения запросы
   * при исчерпании пула висят бесконечно: клиент видит зависший интерфейс,
   * а не ошибку, и не понимает, что происходит. Лучше быстрый отказ.
   */
  databaseConnectionTimeoutMs: Number(env.DATABASE_CONNECTION_TIMEOUT_MS ?? 5000),
  databaseIdleTimeoutMs: Number(env.DATABASE_IDLE_TIMEOUT_MS ?? 30_000),
  databaseStatementTimeoutMs: Number(env.DATABASE_STATEMENT_TIMEOUT_MS ?? 15_000),

  /** Канал для рассылки событий между инстансами (Postgres LISTEN/NOTIFY). */
  replicationUrl: env.DATABASE_REPLICATION_URL ?? null,

  /** В dev генерируется случайный секрет при старте: перезапуск инвалидирует токены. */
  jwtSecret: requiredInProduction('JWT_SECRET', randomBytes(32).toString('hex')),
  accessTokenTtlSec: 15 * 60,
  refreshTokenTtlSec: 30 * 24 * 60 * 60,

  /** Лимит на /auth/* — самая атакуемая точка. Понижается только в тестах. */
  authRateLimitMax: Number(env.AUTH_RATE_LIMIT_MAX ?? 10),
  apiRateLimitMax: Number(env.API_RATE_LIMIT_MAX ?? 300),

  corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(','),

  /** Сколько событий сервер готов доиграть клиенту, прежде чем потребовать resync. */
  maxReplayEvents: 500,
  /** Ретеншен журнала событий и ключей идемпотентности. */
  eventRetentionDays: 90,
  idempotencyRetentionHours: 24,

  scrypt: { N: 1 << 15, r: 8, p: 1, keylen: 32 },
} as const;
