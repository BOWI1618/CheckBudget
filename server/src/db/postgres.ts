import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import type { Database, Dialect, Row } from './driver.js';
import { toNumberedPlaceholders } from './driver.js';
import { currentUserId } from '../core/context.js';

const { Pool, types } = pg;

/**
 * Приведение типов Postgres к тому же виду, что отдаёт SQLite.
 *
 * Без этого прикладной код пришлось бы ветвить по драйверу в каждом мапере:
 * даты приходили бы то строкой, то объектом Date, а суммы — то числом,
 * то строкой. Разница вылезала бы не в тестах, а в проде.
 */
function configureTypeParsers(): void {
  // int8 (BIGINT). Суммы ограничены 10^15 минорных единиц, поэтому
  // помещаются в Number без потери точности. Строка здесь была бы
  // безопаснее в общем случае, но сломала бы всю арифметику приложения.
  types.setTypeParser(types.builtins.INT8, (value) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new Error(`BIGINT вне безопасного диапазона: ${value}`);
    }
    return n;
  });

  // NUMERIC. Отдельный случай: SUM() над BIGINT в Postgres возвращает
  // numeric, а не bigint, и по умолчанию приходит СТРОКОЙ. Без этого парсера
  // все денежные агрегаты — балансы счетов, прогресс лимитов, итоги
  // аналитики — молча превращались бы в конкатенацию строк.
  types.setTypeParser(types.builtins.NUMERIC, (value) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new Error(`NUMERIC вне безопасного целочисленного диапазона: ${value}`);
    }
    return n;
  });

  // DATE — календарная дата, а не момент времени. Возвращаем как есть,
  // иначе часовой пояс сервера сдвинул бы дату операции на день.
  types.setTypeParser(types.builtins.DATE, (value) => value);

  // TIMESTAMPTZ / TIMESTAMP → ISO-строка, как в SQLite.
  const toIso = (value: string) => new Date(value).toISOString();
  types.setTypeParser(types.builtins.TIMESTAMPTZ, toIso);
  types.setTypeParser(types.builtins.TIMESTAMP, toIso);

  // JSONB отдаём строкой: прикладной код делает JSON.parse сам,
  // и он должен вести себя одинаково на обоих драйверах.
  types.setTypeParser(types.builtins.JSONB, (value) => value);
  types.setTypeParser(types.builtins.JSON, (value) => value);
}

configureTypeParsers();

/**
 * Текущая транзакция.
 *
 * Запросы внутри tx() обязаны идти по тому же соединению, что и BEGIN,
 * иначе они выполнятся вне транзакции и не увидят её изменений.
 * AsyncLocalStorage позволяет не протаскивать соединение параметром
 * через каждый сервисный вызов.
 */
const activeTx = new AsyncLocalStorage<pg.PoolClient>();

export class PostgresDatabase implements Database {
  readonly dialect: Dialect = 'postgres';
  private readonly pool: pg.Pool;

  constructor(connectionString: string, max = 10) {
    this.pool = new Pool({ connectionString, max });
  }

  private async query(sql: string, params: unknown[]): Promise<pg.QueryResult> {
    const text = toNumberedPlaceholders(sql);

    const client = activeTx.getStore();
    if (client) return client.query(text, params);

    // Вне транзакции app.user_id установить негде: SET LOCAL действует
    // только внутри транзакции. Поэтому одиночный запрос от имени
    // пользователя оборачивается в неявную транзакцию — иначе RLS
    // не отдаст ни строки даже на чтение.
    //
    // Это лишние обращения к серверу, поэтому маршруты, делающие
    // несколько запросов подряд, открывают транзакцию явно и платят один раз.
    const actor = currentUserId();
    if (!actor) return this.pool.query(text, params);

    return this.tx(async () => {
      const inner = activeTx.getStore()!;
      return inner.query(text, params);
    }, actor);
  }

  async all<T = Row>(sql: string, ...params: unknown[]): Promise<T[]> {
    return (await this.query(sql, params)).rows as T[];
  }

  async get<T = Row>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return (await this.query(sql, params)).rows[0] as T | undefined;
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    return { changes: (await this.query(sql, params)).rowCount ?? 0 };
  }

  async tx<T>(fn: () => Promise<T>, actorId?: string | null): Promise<T> {
    // Вложенный вызов работает внутри уже открытой транзакции.
    if (activeTx.getStore()) return fn();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Без этого RLS не пропустит ни одной строки: все политики опираются
      // на app.user_id. SET LOCAL действует до конца транзакции и не течёт
      // в следующее использование соединения из пула.
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', actorId ?? '']);

      const result = await activeTx.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* соединение уже разорвано */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async setLocal(key: string, value: string): Promise<void> {
    const client = activeTx.getStore();
    if (!client) throw new Error(`setLocal(${key}) вне транзакции: SET LOCAL не имеет эффекта`);
    await client.query('SELECT set_config($1, $2, true)', [key, value]);
  }

  /**
   * Схему применяет отдельная роль-владелец (npm run db:migrate).
   *
   * Приложение не должно уметь менять схему: роль, которой оно ходит,
   * намеренно не владеет таблицами — иначе она обходила бы RLS везде,
   * где не включён FORCE, и второй рубеж защиты исчез бы молча.
   */
  async migrate(): Promise<void> {
    const applied = await this.get<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'budgets'
       ) AS exists`,
    );
    if (!applied?.exists) {
      throw new Error(
        'Схема не применена. Выполните: npm run db:migrate --workspace=server ' +
        '(с DATABASE_MIGRATION_URL от имени владельца схемы)',
      );
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
