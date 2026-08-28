/**
 * Интерфейс доступа к БД.
 *
 * Асинхронный, хотя SQLite синхронен: Postgres принципиально асинхронен,
 * и единственный способ иметь один прикладной код для обоих — сделать
 * асинхронной общую границу. Обратное невозможно.
 */
export type Row = Record<string, unknown>;

export type Dialect = 'sqlite' | 'postgres';

export interface Database {
  readonly dialect: Dialect;

  all<T = Row>(sql: string, ...params: unknown[]): Promise<T[]>;
  get<T = Row>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;

  /**
   * Транзакция. Вложенные вызовы разделяют одну внешнюю транзакцию,
   * поэтому сервисные функции можно свободно комбинировать.
   *
   * `actorId` — идентификатор пользователя для RLS: Postgres выполняет
   * `SET LOCAL app.user_id`, и без него политики не пропустят ни одной строки.
   * SQLite его игнорирует, но принимает — чтобы прикладной код был один.
   */
  tx<T>(fn: () => Promise<T>, actorId?: string | null): Promise<T>;

  /**
   * Устанавливает переменную на время текущей транзакции.
   *
   * Нужна там, где право доступа определяется не членством, а знанием
   * секрета — например, при приёме приглашения по коду. В Postgres
   * значение читается политикой через current_setting; SQLite его
   * игнорирует, потому что RLS там нет.
   */
  setLocal(key: string, value: string): Promise<void>;

  migrate(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Нормализация значений параметров.
 *
 * node:sqlite не принимает JS-булевы значения, Postgres не принимает 0/1
 * там, где ожидается BOOLEAN. Прикладной код всегда передаёт настоящие
 * булевы значения, а приведение выполняет драйвер.
 */
export const sqliteParam = (value: unknown): unknown =>
  typeof value === 'boolean' ? (value ? 1 : 0) : value;

/**
 * Перевод плейсхолдеров `?` в нумерованные `$1, $2, …`.
 *
 * Строковые литералы пропускаются: `?` внутри кавычек не является
 * плейсхолдером, и без этой проверки нумерация поехала бы.
 */
export function toNumberedPlaceholders(sql: string): string {
  let out = '';
  let index = 0;
  let quote: string | null = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch === '?' ? `$${++index}` : ch;
  }
  return out;
}
