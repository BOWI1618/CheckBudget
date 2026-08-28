import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Database, Dialect, Row } from './driver.js';
import { sqliteParam } from './driver.js';

const here = dirname(fileURLToPath(import.meta.url));

export class SqliteDatabase implements Database {
  readonly dialect: Dialect = 'sqlite';
  readonly raw: DatabaseSync;

  private depth = 0;
  /**
   * Очередь транзакций.
   *
   * Соединение одно, а API теперь асинхронный — значит две параллельные
   * транзакции могли бы перемешать свои BEGIN/COMMIT на одном соединении
   * и превратиться в одну. Раньше этого не могло случиться просто потому,
   * что вызовы были синхронными; теперь порядок нужно поддерживать явно.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    // NORMAL безопасен в режиме WAL и заметно быстрее FULL.
    this.raw.exec('PRAGMA synchronous = NORMAL');
  }

  async all<T = Row>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.raw.prepare(sql).all(...(params.map(sqliteParam) as never[])) as T[];
  }

  async get<T = Row>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return this.raw.prepare(sql).get(...(params.map(sqliteParam) as never[])) as T | undefined;
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const result = this.raw.prepare(sql).run(...(params.map(sqliteParam) as never[]));
    return { changes: Number(result.changes) };
  }

  async tx<T>(fn: () => Promise<T>, _actorId?: string | null): Promise<T> {
    if (this.depth > 0) {
      this.depth++;
      try {
        return await fn();
      } finally {
        this.depth--;
      }
    }

    const run = async (): Promise<T> => {
      // IMMEDIATE, а не DEFERRED: блокировка берётся сразу, что исключает
      // SQLITE_BUSY на середине транзакции при конкурентных записях.
      this.raw.exec('BEGIN IMMEDIATE');
      this.depth = 1;
      try {
        const result = await fn();
        this.raw.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          this.raw.exec('ROLLBACK');
        } catch {
          /* транзакция уже откачена движком */
        }
        throw err;
      } finally {
        this.depth = 0;
      }
    };

    const next = this.queue.then(run, run);
    // Ошибка одной транзакции не должна обрывать очередь следующих.
    this.queue = next.catch(() => undefined);
    return next;
  }

  async setLocal(_key: string, _value: string): Promise<void> {
    // RLS в SQLite нет — переменные транзакции не нужны.
  }

  /**
   * Миграции.
   *
   * schema.sql — базовая схема; она идемпотентна (IF NOT EXISTS) и создаёт
   * пустую базу с нуля. Но IF NOT EXISTS не умеет изменять СУЩЕСТВУЮЩИЕ
   * таблицы, поэтому каждое последующее изменение схемы добавляется сюда
   * отдельным шагом. Текущая версия хранится в PRAGMA user_version.
   *
   * Правило: шаги только добавляются и никогда не редактируются задним числом —
   * иначе базы, уже прошедшие миграцию, разойдутся с новыми.
   */
  private static readonly MIGRATIONS: Array<{ version: number; sql: string }> = [
    // v2: журнал событий запоминает устройство, а не только пользователя.
    { version: 2, sql: 'ALTER TABLE events ADD COLUMN actor_client_id TEXT' },
    // v3: email_lower заменён уникальным индексом по LOWER(email) —
    // в Postgres той же цели служит тип CITEXT, и без этого шага
    // две схемы расходились бы в структуре таблицы users.
    {
      version: 3,
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email));
            ALTER TABLE users DROP COLUMN email_lower;`,
    },
  ];

  async migrate(): Promise<void> {
    // Проверяем ДО применения baseline: пустой файл и существующая база
    // после него неразличимы, а обходиться с ними нужно по-разному.
    const isFresh = !(await this.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'users'"));

    this.raw.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));

    const target = SqliteDatabase.MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 1);

    if (isFresh) {
      this.raw.exec(`PRAGMA user_version = ${target}`);
      return;
    }

    // Базы, созданные до появления user_version, считаются версией 1.
    const current =
      (await this.get<{ user_version: number }>('PRAGMA user_version'))?.user_version || 1;

    for (const migration of SqliteDatabase.MIGRATIONS) {
      if (migration.version <= current) continue;
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        this.raw.exec(migration.sql);
        this.raw.exec(`PRAGMA user_version = ${migration.version}`);
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    }
  }

  async close(): Promise<void> {
    this.raw.close();
  }
}
