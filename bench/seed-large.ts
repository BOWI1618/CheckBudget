/**
 * Крупный набор данных для замеров.
 *
 * Демонстрационные 285 операций ничего не говорят о масштабировании: на такой
 * выборке любой запрос быстр. Здесь генерируется объём, соответствующий
 * нескольким годам активного семейного бюджета, — только на нём видно,
 * какие запросы растут линейно, а какие нет.
 *
 *   npx tsx bench/seed-large.ts --years 3
 */
import { db } from '../server/src/db/index.js';
import { newId, nowIso } from '../server/src/core/ids.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1]!;
};

const YEARS = Number(arg('years', '3'));
const PER_MONTH = Number(arg('per-month', '160'));

async function main(): Promise<void> {
  // Таблица budgets закрыта RLS, поэтому сначала находим пользователя
  // (users политиками не закрыт), а дальше читаем уже от его имени.
  const user = await db.get<{ id: string }>(
    'SELECT id FROM users WHERE LOWER(email) = ?', arg('email', 'ivan@example.com'),
  );
  if (!user) throw new Error('Нет пользователя — сначала запустите демо-сид');
  const owner = user.id;

  const budget = await db.tx(
    () => db.get<{ id: string }>('SELECT id FROM budgets ORDER BY created_at LIMIT 1'),
    owner,
  );
  if (!budget) throw new Error('Нет бюджета — сначала запустите демо-сид');

  const accounts = await db.tx(
    () => db.all<{ id: string; currency: string }>(
      "SELECT id, currency FROM accounts WHERE budget_id = ? AND currency = 'RUB'", budget.id),
    owner,
  );
  const categories = await db.tx(
    () => db.all<{ id: string }>(
      "SELECT id FROM categories WHERE budget_id = ? AND kind = 'expense' AND parent_id IS NOT NULL",
      budget.id),
    owner,
  );
  if (accounts.length === 0 || categories.length === 0) throw new Error('Нет счетов или категорий');

  const ts = nowIso();
  const months = YEARS * 12;
  const now = new Date();
  let inserted = 0;

  console.log(`Генерирую ${months} мес. × ~${PER_MONTH} операций…`);

  for (let back = months; back >= 1; back--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const daysInMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    const monthPrefix = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;

    // Одна транзакция на месяц: коммит на каждую строку сделал бы сид
    // на порядок медленнее самой генерации.
    await db.tx(async () => {
      for (let i = 0; i < PER_MONTH; i++) {
        const day = 1 + Math.floor(Math.random() * daysInMonth);
        const account = accounts[Math.floor(Math.random() * accounts.length)]!;
        const category = categories[Math.floor(Math.random() * categories.length)]!;
        const amount = 5000 + Math.floor(Math.random() * 500000);

        await db.run(
          `INSERT INTO transactions
             (id, budget_id, type, account_id, category_id, amount_minor, currency,
              base_amount_minor, base_currency, rate_num, rate_den, rate_date, rate_source,
              occurred_on, created_by, updated_by, created_at, updated_at, version)
           VALUES (?,?, 'expense', ?,?,?, 'RUB', ?, 'RUB', 1, 1, ?, 'identity', ?,?,?,?,?, 1)`,
          newId(), budget.id, account.id, category.id, amount, amount,
          `${monthPrefix}-01`,
          `${monthPrefix}-${String(day).padStart(2, '0')}`,
          owner, owner, ts, ts,
        );
        inserted++;
      }
    }, owner);

    if (back % 6 === 0) console.log(`  осталось месяцев: ${back}`);
  }

  const total = await db.tx(
    () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions'),
    owner,
  );
  console.log(`Добавлено ${inserted}; всего операций в базе: ${total!.n}`);
  await db.close();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
