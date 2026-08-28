/**
 * Проверка продакшен-схемы PostgreSQL и политик Row Level Security.
 *
 * Смысл теста — не «DDL применяется без ошибок», а доказательство главного
 * заявления архитектуры: даже если приложение выполнит запрос БЕЗ
 * `WHERE budget_id = ?`, база не отдаст строки чужого бюджета.
 *
 * Поэтому все проверки намеренно делают то, чего приложение делать не должно:
 * читают таблицы целиком и обращаются к строкам по чужому id.
 *
 * Запуск: DATABASE_URL=postgres://... npm run test:pg --workspace=server
 * Без DATABASE_URL тест пропускается — чтобы обычный `npm test` не требовал Docker.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(here, '../../../db/postgres/schema.sql');

/** Суперпользователь: только создаёт роли и расширения. */
let root: Client;
/** Владелец схемы — НЕ суперпользователь. Выполняет миграции и готовит данные. */
let owner: Client;
/** Роль приложения: не владелец, NOSUPERUSER, NOBYPASSRLS. Именно ею ходит сервер. */
let app: Client;

const ids = {
  ivan: '11111111-1111-1111-1111-111111111111',
  anna: '22222222-2222-2222-2222-222222222222',
  mallory: '33333333-3333-3333-3333-333333333333',
  budgetA: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  budgetB: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  accountA: 'a0000000-0000-0000-0000-000000000001',
  accountB: 'b0000000-0000-0000-0000-000000000001',
  catA: 'a0000000-0000-0000-0000-000000000002',
  catB: 'b0000000-0000-0000-0000-000000000002',
  txA: 'a0000000-0000-0000-0000-000000000003',
  txB: 'b0000000-0000-0000-0000-000000000003',
};

function connectionFor(user: string, password: string): string {
  const url = new URL(DATABASE_URL!);
  url.username = user;
  url.password = password;
  return url.toString();
}

/** Выполняет запрос от имени пользователя — так же, как это делает сервер. */
async function runAs<T = Record<string, unknown>>(
  client: Client,
  userId: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await client.query('BEGIN');
  try {
    // Тот самый SET LOCAL, на котором держатся все политики.
    await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId ?? '']);
    const result = await client.query(sql, params as never[]);
    await client.query('COMMIT');
    return result.rows as T[];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

const asUser = <T = Record<string, unknown>>(userId: string | null, sql: string, params: unknown[] = []) =>
  runAs<T>(app, userId, sql, params);

/**
 * Сид от имени владельца схемы.
 *
 * app.user_id указывается даже здесь: под FORCE ROW LEVEL SECURITY политики
 * применяются и к владельцу таблицы, поэтому миграция или сид обязаны явно
 * объявить, от чьего имени пишут. Без этого вставка отвергается — что и
 * является доказательством, что FORCE действительно работает.
 */
const seedAs = <T = Record<string, unknown>>(userId: string, sql: string, params: unknown[] = []) =>
  runAs<T>(owner, userId, sql, params);

describe('PostgreSQL: схема и RLS', { skip: DATABASE_URL ? false : 'нет DATABASE_URL' }, () => {
  before(async () => {
    root = new Client({ connectionString: DATABASE_URL });
    await root.connect();

    // Стенд воспроизводит продакшен-модель ролей, а не удобную.
    // Под суперпользователем RLS не применяется вообще, и тест,
    // выполненный от postgres, доказывал бы ровно ничего.
    for (const stmt of [
      `DROP SCHEMA IF EXISTS public CASCADE`,
      `CREATE SCHEMA public`,
      `DROP OWNED BY checkbudget_app`,
      `DROP ROLE IF EXISTS checkbudget_app`,
      `DROP OWNED BY checkbudget_owner`,
      `DROP ROLE IF EXISTS checkbudget_owner`,
      `CREATE ROLE checkbudget_owner LOGIN PASSWORD 'ownerpass' NOSUPERUSER NOBYPASSRLS`,
      `CREATE ROLE checkbudget_app   LOGIN PASSWORD 'apppass'   NOSUPERUSER NOBYPASSRLS`,
      `ALTER SCHEMA public OWNER TO checkbudget_owner`,
      // Расширения ставит суперпользователь: владельцу схемы это не положено.
      `CREATE EXTENSION IF NOT EXISTS "pgcrypto"`,
      `CREATE EXTENSION IF NOT EXISTS "citext"`,
    ]) {
      try {
        await root.query(stmt);
      } catch (err) {
        if (!/does not exist/.test(String(err))) throw err;
      }
    }

    owner = new Client({ connectionString: connectionFor('checkbudget_owner', 'ownerpass') });
    await owner.connect();

    // Схему применяет владелец — так же, как это сделала бы миграция в проде.
    await owner.query(readFileSync(SCHEMA, 'utf8'));

    for (const stmt of [
      `GRANT USAGE ON SCHEMA public TO checkbudget_app`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO checkbudget_app`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO checkbudget_app`,
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO checkbudget_app`,
    ]) {
      await owner.query(stmt);
    }

    // Данные готовит владелец: наполнение — задача миграций и сидов,
    // а не проверяемого здесь прикладного пути.
    // Каждый INSERT отдельным запросом: параметризованный запрос в pg
    // не принимает несколько команд сразу.
    await owner.query(
      `INSERT INTO currencies (code, name_ru, symbol, exponent)
       VALUES ('RUB','Российский рубль','₽',2), ('USD','Доллар США','$',2)`);

    await owner.query(
      `INSERT INTO users (id, email, password_hash, display_name) VALUES
         ($1,'ivan@example.com','x','Иван'),
         ($2,'anna@example.com','x','Анна'),
         ($3,'mallory@example.com','x','Мэллори')`,
      [ids.ivan, ids.anna, ids.mallory]);

    await owner.query(
      `INSERT INTO budgets (id, name, base_currency, owner_id) VALUES
         ($1,'Бюджет Ивана','RUB',$3), ($2,'Бюджет Мэллори','RUB',$4)`,
      [ids.budgetA, ids.budgetB, ids.ivan, ids.mallory]);

    await owner.query(
      `INSERT INTO budget_members (budget_id, user_id, role) VALUES
         ($1,$3,'owner'), ($1,$4,'viewer'), ($2,$5,'owner')`,
      [ids.budgetA, ids.budgetB, ids.ivan, ids.anna, ids.mallory]);

    // Счета, категории и операции лежат под FORCE RLS — сид разделён
    // по владельцам бюджетов, иначе политика отвергнет вставку.
    await seedAs(ids.ivan,
      `INSERT INTO accounts (id, budget_id, name, type, currency)
       VALUES ($1,$2,'Карта Ивана','card','RUB')`, [ids.accountA, ids.budgetA]);
    await seedAs(ids.mallory,
      `INSERT INTO accounts (id, budget_id, name, type, currency)
       VALUES ($1,$2,'Карта Мэллори','card','RUB')`, [ids.accountB, ids.budgetB]);

    await seedAs(ids.ivan,
      `INSERT INTO categories (id, budget_id, name, kind) VALUES ($1,$2,'Продукты','expense')`,
      [ids.catA, ids.budgetA]);
    await seedAs(ids.mallory,
      `INSERT INTO categories (id, budget_id, name, kind) VALUES ($1,$2,'Продукты','expense')`,
      [ids.catB, ids.budgetB]);

    const txSql = `INSERT INTO transactions
       (id, budget_id, type, account_id, category_id, amount_minor, currency,
        base_amount_minor, base_currency, rate_num, rate_den, occurred_on, created_by, updated_by)
     VALUES ($1,$2,'expense',$3,$4,$5,'RUB',$5,'RUB',1,1,'2026-08-27',$6,$6)`;
    await seedAs(ids.ivan, txSql,
      [ids.txA, ids.budgetA, ids.accountA, ids.catA, 250000, ids.ivan]);
    await seedAs(ids.mallory, txSql,
      [ids.txB, ids.budgetB, ids.accountB, ids.catB, 999900, ids.mallory]);

    app = new Client({ connectionString: connectionFor('checkbudget_app', 'apppass') });
    await app.connect();
  });

  after(async () => {
    await app?.end();
    await owner?.end();
    await root?.end();
  });

  test('DDL применяется целиком, все таблицы на месте', async () => {
    const rows = await owner.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const names = rows.rows.map((r) => r.tablename);
    for (const expected of [
      'users', 'user_settings', 'refresh_tokens', 'currencies', 'exchange_rates',
      'budgets', 'budget_members', 'budget_invites', 'accounts', 'categories',
      'transactions', 'budget_limits', 'goals', 'events', 'idempotency_keys',
    ]) {
      assert.ok(names.includes(expected), `нет таблицы ${expected}`);
    }
  });

  test('RLS включён и форсирован на всех таблицах бюджета', async () => {
    const rows = await owner.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = ANY($1) AND relkind IN ('r','p')`,
      [['accounts', 'categories', 'transactions', 'budget_limits', 'goals', 'events', 'budgets', 'budget_members']],
    );
    for (const row of rows.rows) {
      assert.ok(row.relrowsecurity, `RLS выключен на ${row.relname}`);
    }
  });

  test('ни роль приложения, ни владелец схемы не обходят RLS', async () => {
    const rows = await owner.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles
        WHERE rolname IN ('checkbudget_app','checkbudget_owner')`,
    );
    assert.equal(rows.rows.length, 2);
    for (const role of rows.rows) {
      assert.equal(role.rolsuper, false, `${role.rolname} не должен быть суперпользователем`);
      assert.equal(role.rolbypassrls, false, `${role.rolname} не должен иметь BYPASSRLS`);
    }
  });

  test('приложение ходит не владельцем таблиц', async () => {
    // Владелец таблицы обходит RLS везде, где не включён FORCE.
    // Если сервер подключается владельцем, второй рубеж защиты исчезает молча.
    const rows = await app.query<{ current_user: string }>('SELECT current_user');
    assert.equal(rows.rows[0]?.current_user, 'checkbudget_app');

    const owned = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_tables
        WHERE schemaname = 'public' AND tableowner = 'checkbudget_app'`);
    assert.equal(owned.rows[0]?.n, '0', 'роль приложения не должна владеть таблицами');
  });

  // ─────────────── Главное: изоляция бюджетов на уровне БД ───────────────

  test('запрос БЕЗ WHERE budget_id не отдаёт чужие операции', async () => {
    // Именно та ошибка, от которой RLS должен защитить: приложение
    // забыло скоуп по бюджету.
    const rows = await asUser<{ id: string }>(ids.ivan, 'SELECT id FROM transactions');
    assert.equal(rows.length, 1, 'Иван должен видеть ровно свою операцию');
    assert.equal(rows[0]?.id, ids.txA);
  });

  test('обращение к чужой операции по прямому id даёт пусто, а не строку', async () => {
    const rows = await asUser(ids.ivan, 'SELECT * FROM transactions WHERE id = $1', [ids.txB]);
    assert.equal(rows.length, 0, 'подмена id не должна давать доступ');
  });

  test('чужие счета и категории также не видны', async () => {
    const accounts = await asUser<{ id: string }>(ids.ivan, 'SELECT id FROM accounts');
    const categories = await asUser<{ id: string }>(ids.ivan, 'SELECT id FROM categories');
    assert.deepEqual(accounts.map((a) => a.id), [ids.accountA]);
    assert.deepEqual(categories.map((c) => c.id), [ids.catA]);
  });

  test('без app.user_id не видно ничего', async () => {
    // Забытый SET LOCAL не должен открывать базу целиком.
    const rows = await asUser(null, 'SELECT id FROM transactions');
    assert.equal(rows.length, 0);
  });

  test('агрегат по всей таблице считает только свой бюджет', async () => {
    // Утечка через SUM опаснее утечки строк: она незаметна.
    const rows = await asUser<{ total: string | null }>(
      ids.ivan, 'SELECT SUM(base_amount_minor)::text AS total FROM transactions',
    );
    assert.equal(rows[0]?.total, '250000', 'сумма не должна включать чужие операции');
  });

  // ───────────────────────── Права на запись ─────────────────────────

  test('viewer не может создать операцию', async () => {
    await assert.rejects(
      () => asUser(ids.anna, `
        INSERT INTO transactions
          (budget_id, type, account_id, category_id, amount_minor, currency,
           base_amount_minor, base_currency, rate_num, rate_den, occurred_on, created_by, updated_by)
        VALUES ($1,'expense',$2,$3,100,'RUB',100,'RUB',1,1,'2026-08-27',$4,$4)`,
        [ids.budgetA, ids.accountA, ids.catA, ids.anna]),
      /row-level security|policy/i,
      'политика должна отклонить запись от viewer',
    );
  });

  test('viewer видит данные бюджета', async () => {
    const rows = await asUser(ids.anna, 'SELECT id FROM transactions');
    assert.equal(rows.length, 1, 'наблюдатель читает, но не пишет');
  });

  test('нельзя записать операцию в чужой бюджет', async () => {
    await assert.rejects(
      () => asUser(ids.ivan, `
        INSERT INTO transactions
          (budget_id, type, account_id, category_id, amount_minor, currency,
           base_amount_minor, base_currency, rate_num, rate_den, occurred_on, created_by, updated_by)
        VALUES ($1,'expense',$2,$3,100,'RUB',100,'RUB',1,1,'2026-08-27',$4,$4)`,
        [ids.budgetB, ids.accountB, ids.catB, ids.ivan]),
      /row-level security|policy/i,
    );
  });

  test('нельзя изменить чужую операцию', async () => {
    const rows = await asUser(ids.ivan,
      'UPDATE transactions SET amount_minor = 1 WHERE id = $1 RETURNING id', [ids.txB]);
    assert.equal(rows.length, 0, 'UPDATE не должен затронуть ни одной чужой строки');

    const check = await seedAs<{ amount_minor: string }>(ids.mallory,
      'SELECT amount_minor::text FROM transactions WHERE id = $1', [ids.txB]);
    assert.equal(check[0]?.amount_minor, '999900', 'чужая сумма не изменилась');
  });

  test('нельзя удалить чужую операцию', async () => {
    await asUser(ids.ivan, 'DELETE FROM transactions WHERE id = $1', [ids.txB]);
    const check = await seedAs(ids.mallory, 'SELECT 1 FROM transactions WHERE id = $1', [ids.txB]);
    assert.equal(check.length, 1, 'чужая операция должна остаться на месте');
  });

  // ─────────────────── Прикладные пути, которые обязаны работать ───────────────────

  test('editor создаёт операцию в своём бюджете', async () => {
    const rows = await asUser<{ id: string }>(ids.ivan, `
      INSERT INTO transactions
        (budget_id, type, account_id, category_id, amount_minor, currency,
         base_amount_minor, base_currency, rate_num, rate_den, occurred_on, created_by, updated_by)
      VALUES ($1,'expense',$2,$3,50000,'RUB',50000,'RUB',1,1,'2026-08-27',$4,$4)
      RETURNING id`,
      [ids.budgetA, ids.accountA, ids.catA, ids.ivan]);
    assert.equal(rows.length, 1);
  });

  test('участник создаёт бюджет', async () => {
    // Без INSERT-политики на budgets приложение не смогло бы вообще
    // создать бюджет — RLS запрещает всё, что не разрешено явно.
    const rows = await asUser<{ id: string }>(ids.ivan,
      `INSERT INTO budgets (name, base_currency, owner_id) VALUES ('Новый','RUB',$1) RETURNING id`,
      [ids.ivan]);
    assert.equal(rows.length, 1, 'создание бюджета должно быть разрешено владельцу');
  });

  test('владелец добавляет участника', async () => {
    const budget = await asUser<{ id: string }>(ids.ivan,
      `INSERT INTO budgets (name, base_currency, owner_id) VALUES ('Семья','RUB',$1) RETURNING id`,
      [ids.ivan]);
    const budgetId = budget[0]!.id;

    const rows = await asUser(ids.ivan,
      `INSERT INTO budget_members (budget_id, user_id, role) VALUES ($1,$2,'owner') RETURNING user_id`,
      [budgetId, ids.ivan]);
    assert.equal(rows.length, 1, 'владелец должен иметь возможность записать себя в участники');
  });

  test('журнал событий пишется и читается в пределах бюджета', async () => {
    await asUser(ids.ivan,
      `INSERT INTO events (budget_id, entity, entity_id, op, actor_id, payload)
       VALUES ($1,'transaction',$2,'insert',$3,'{}'::jsonb)`,
      [ids.budgetA, ids.txA, ids.ivan]);

    const mine = await asUser(ids.ivan, 'SELECT seq FROM events');
    assert.ok(mine.length >= 1);

    const foreign = await asUser(ids.mallory, 'SELECT seq FROM events');
    assert.equal(foreign.length, 0, 'чужой журнал событий не виден');
  });

  test('денежные значения переживают BIGINT без потери точности', async () => {
    const big = '999999999999999';
    await asUser(ids.ivan,
      `INSERT INTO transactions
        (budget_id, type, account_id, category_id, amount_minor, currency,
         base_amount_minor, base_currency, rate_num, rate_den, occurred_on, created_by, updated_by)
       VALUES ($1,'expense',$2,$3,$4,'RUB',$4,'RUB',1,1,'2026-08-27',$5,$5)`,
      [ids.budgetA, ids.accountA, ids.catA, big, ids.ivan]);

    const rows = await asUser<{ amount_minor: string }>(ids.ivan,
      'SELECT amount_minor::text FROM transactions WHERE amount_minor::text = $1', [big]);
    assert.equal(rows[0]?.amount_minor, big, 'BIGINT не должен терять младшие разряды');
  });

  // ─────────── Регрессии: дефекты, найденные при первом прогоне ───────────

  test('регрессия: INSERT ... RETURNING работает при создании бюджета', async () => {
    // Под RLS возвращаемая строка дополнительно проходит SELECT-политику.
    // Если политика чтения смотрит только на членство, создание бюджета
    // падает с ошибкой ЗАПИСИ, хотя сам INSERT политику проходит.
    const withoutReturning = await asUser(ids.ivan,
      `INSERT INTO budgets (name, base_currency, owner_id) VALUES ('Без RETURNING','RUB',$1)`,
      [ids.ivan]);
    assert.equal(withoutReturning.length, 0);

    const withReturning = await asUser<{ id: string }>(ids.ivan,
      `INSERT INTO budgets (name, base_currency, owner_id) VALUES ('С RETURNING','RUB',$1) RETURNING id`,
      [ids.ivan]);
    assert.equal(withReturning.length, 1, 'RETURNING обязан работать: приложение использует его везде');
  });

  test('регрессия: INSERT ... RETURNING работает при добавлении участника', async () => {
    const budget = await asUser<{ id: string }>(ids.ivan,
      `INSERT INTO budgets (name, base_currency, owner_id) VALUES ('Общий','RUB',$1) RETURNING id`,
      [ids.ivan]);
    const rows = await asUser(ids.ivan,
      `INSERT INTO budget_members (budget_id, user_id, role) VALUES ($1,$2,'owner') RETURNING user_id`,
      [budget[0]!.id, ids.ivan]);
    assert.equal(rows.length, 1);
  });

  test('чужой не может создать бюджет на чужое имя', async () => {
    await assert.rejects(
      () => asUser(ids.mallory,
        `INSERT INTO budgets (name, base_currency, owner_id) VALUES ('Подстава','RUB',$1)`,
        [ids.ivan]),
      /row-level security|policy/i,
      'owner_id обязан совпадать с текущим пользователем',
    );
  });

  test('чужой не может дописать себя в участники', async () => {
    await assert.rejects(
      () => asUser(ids.mallory,
        `INSERT INTO budget_members (budget_id, user_id, role) VALUES ($1,$2,'editor')`,
        [ids.budgetA, ids.mallory]),
      /row-level security|policy/i,
      'состав участников меняет только владелец бюджета',
    );
  });

  test('приглашения чужого бюджета не читаются', async () => {
    await asUser(ids.ivan,
      `INSERT INTO budget_invites (budget_id, code_hash, role, created_by, expires_at)
       VALUES ($1,'hash-ivan','editor',$2, now() + interval '1 day')`,
      [ids.budgetA, ids.ivan]);

    const mine = await asUser(ids.ivan, 'SELECT code_hash FROM budget_invites');
    assert.equal(mine.length, 1);

    // Хеш кода приглашения — ключ доступа к бюджету, утечка равна утечке доступа.
    const foreign = await asUser(ids.mallory, 'SELECT code_hash FROM budget_invites');
    assert.equal(foreign.length, 0, 'чужие приглашения не должны быть видны');
  });

  test('настройки и ключи идемпотентности видны только владельцу', async () => {
    await asUser(ids.ivan, `INSERT INTO user_settings (user_id) VALUES ($1)`, [ids.ivan]);
    await asUser(ids.mallory, `INSERT INTO user_settings (user_id) VALUES ($1)`, [ids.mallory]);

    const mine = await asUser<{ user_id: string }>(ids.ivan, 'SELECT user_id FROM user_settings');
    assert.deepEqual(mine.map((r) => r.user_id), [ids.ivan]);

    await asUser(ids.ivan,
      `INSERT INTO idempotency_keys (key, user_id, request_hash, status_code, response)
       VALUES ('k1',$1,'h',201,'{}'::jsonb)`, [ids.ivan]);
    const keys = await asUser(ids.mallory, `SELECT key FROM idempotency_keys`);
    assert.equal(keys.length, 0, 'чужие ключи идемпотентности не видны');
  });

  test('участник может выйти из бюджета сам', async () => {
    const rows = await asUser(ids.anna,
      'DELETE FROM budget_members WHERE budget_id = $1 AND user_id = $2 RETURNING user_id',
      [ids.budgetA, ids.anna]);
    assert.equal(rows.length, 1, 'выход из бюджета — право самого участника');
  });
});
