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
    ? new PostgresDatabase(config.databaseUrl, config.databasePoolSize)
    : new SqliteDatabase(config.databaseFile);
}

export const db: Database = createDatabase();
