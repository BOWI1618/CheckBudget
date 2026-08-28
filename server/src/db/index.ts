import { config } from '../config.js';
import type { Database } from './driver.js';
import { SqliteDatabase } from './sqlite.js';
import { PostgresDatabase } from './postgres.js';

export type { Database, Row } from './driver.js';

/**
 * Выбор драйвера.
 *
 * Есть DATABASE_URL — работаем на Postgres, нет — на встроенном SQLite.
 * Прикладной код одинаков для обоих: различия диалектов заканчиваются
 * на границе этого модуля.
 */
export function createDatabase(): Database {
  return config.databaseUrl
    ? new PostgresDatabase(config.databaseUrl, {
        max: config.databasePoolSize,
        connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
        idleTimeoutMillis: config.databaseIdleTimeoutMs,
        statementTimeoutMs: config.databaseStatementTimeoutMs,
      })
    : new SqliteDatabase(config.databaseFile);
}

/** Состояние пула, если драйвер его отдаёт. Для /health. */
export function databaseStats(): Record<string, number> | null {
  const candidate = db as Database & { stats?: () => Record<string, number> };
  return candidate.stats ? candidate.stats() : null;
}

export const db: Database = createDatabase();
