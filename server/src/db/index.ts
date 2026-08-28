import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));

export type Row = Record<string, unknown>;

export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    // NORMAL безопасен в режиме WAL и заметно быстрее FULL.
    this.raw.exec('PRAGMA synchronous = NORMAL');
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
  ];

  migrate(): void {
    // Проверяем ДО применения baseline: пустой файл и существующая база
    // после него неразличимы, а обходиться с ними нужно по-разному.
    const isFresh = !this.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'users'");

    const baseline = readFileSync(join(here, 'schema.sql'), 'utf8');
    this.raw.exec(baseline);

    const target = Db.MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 1);

    if (isFresh) {
      // База создана из актуального schema.sql — все шаги уже в ней учтены.
      this.raw.exec(`PRAGMA user_version = ${target}`);
      return;
    }

    // Базы, созданные до появления user_version, считаются версией 1.
    const current = this.get<{ user_version: number }>('PRAGMA user_version')?.user_version || 1;

    for (const migration of Db.MIGRATIONS) {
      if (migration.version <= current) continue;
      this.tx(() => {
        this.raw.exec(migration.sql);
        this.raw.exec(`PRAGMA user_version = ${migration.version}`);
      });
    }
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...(params as never[])) as T[];
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.raw.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...(params as never[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /**
   * Транзакция. Вложенные вызовы разделяют одну внешнюю транзакцию —
   * это позволяет свободно комбинировать сервисные функции, не думая о том,
   * кто именно открыл транзакцию.
   *
   * IMMEDIATE, а не DEFERRED: блокировка берётся сразу, что исключает
   * SQLITE_BUSY на середине транзакции при конкурентных записях.
   */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const result = fn();
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
  }

  close(): void {
    this.raw.close();
  }
}

export const db = new Db(config.databaseFile);
