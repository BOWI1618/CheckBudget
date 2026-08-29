/**
 * Демонстрационные данные: два пользователя в одном семейном бюджете
 * с историей за полгода. Нужны, чтобы можно было увидеть приложение
 * в реалистичном состоянии сразу после установки.
 *
 * Запуск: npm run demo --workspace=server
 */
import { parseAmount } from '@checkbudget/shared';
import { db } from './index.js';
import { seedReference } from './seed.js';
import { hashPassword } from '../auth/password.js';
import { newId, nowIso } from '../core/ids.js';
import { seedBudgetDefaults } from '../modules/defaults.js';
import { convertToBase } from '../core/rates.js';

const PATTERNS: Array<[string, string, number, number, number]> = [
  // [категория, комментарий, мин. сумма ₽, макс. сумма ₽, операций в месяц]
  ['Супермаркет', 'Продукты', 800, 4500, 9],
  ['Рынок', 'Овощи и фрукты', 400, 1600, 2],
  ['Кофе', 'Кофе', 200, 450, 8],
  ['Обеды', 'Обед', 500, 1400, 5],
  ['Доставка', 'Доставка еды', 900, 2600, 3],
  ['Такси', 'Такси', 300, 900, 6],
  ['Общественный транспорт', 'Проездной', 1200, 1200, 1],
  ['Аренда', 'Аренда квартиры', 65000, 65000, 1],
  ['Коммунальные услуги', 'ЖКХ', 4500, 7200, 1],
  ['Аптека', 'Аптека', 400, 2200, 2],
  ['Одежда', '', 2500, 12000, 1],
  ['Подписки', 'Подписки', 299, 1200, 2],
  ['Кино', 'Кино', 700, 1800, 1],
  ['Связь и интернет', 'Связь', 800, 1400, 1],
];

function randomBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function main(): Promise<void> {
  await db.migrate();
  await seedReference();

  const ts = nowIso();
  const password = await hashPassword('demo12345');

  const owner = newId();
  const partner = newId();
  let createdBudgetId = '';
  // Каждый пользователь заводится в своей транзакции: настройки закрыты
  // политикой «только свои», поэтому одна общая транзакция от имени владельца
  // не смогла бы создать настройки второму человеку.
  for (const [id, email, name] of [
    [owner, 'ivan@example.com', 'Иван'],
    [partner, 'anna@example.com', 'Анна'],
  ] as const) {
    await db.tx(async () => {
      await db.run(
        `INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT DO NOTHING`,
        id, email, password, name, ts, ts,
      );
      await db.run(
        `INSERT INTO user_settings (user_id, base_currency, locale, theme, updated_at)
         VALUES (?, 'RUB', 'ru-RU', 'system', ?)
         ON CONFLICT DO NOTHING`,
        id, ts,
      );
    }, id);
  }

  await db.tx(async () => {
    const budgetId = newId();
    await db.run(
      `INSERT INTO budgets (id, name, base_currency, owner_id, created_at, updated_at, version)
       VALUES (?, 'Семейный бюджет', 'RUB', ?, ?, ?, 1)`,
      budgetId, owner, ts, ts,
    );
    await db.run('INSERT INTO budget_members (budget_id, user_id, role, joined_at) VALUES (?,?,?,?)',
      budgetId, owner, 'owner', ts);
    await db.run('INSERT INTO budget_members (budget_id, user_id, role, joined_at) VALUES (?,?,?,?)',
      budgetId, partner, 'editor', ts);

    await seedBudgetDefaults(budgetId, 'RUB');

    // Валютный счёт — чтобы мультивалютность была видна, а не только заявлена.
    const usdAccount = newId();
    await db.run(
      `INSERT INTO accounts (id, budget_id, name, type, currency, initial_balance_minor,
                             color, icon, sort_order, created_at, updated_at, version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
      usdAccount, budgetId, 'Валютный счёт', 'savings', 'USD',
      parseAmount('1200', 'USD'), '#12a2a0', 'savings', 2, ts, ts,
    );

    const accounts = await db.all<{ id: string; currency: string; name: string }>(
      'SELECT id, currency, name FROM accounts WHERE budget_id = ? ORDER BY sort_order', budgetId,
    );
    const card = accounts.find((a) => a.name === 'Карта')!;
    const cash = accounts.find((a) => a.name === 'Наличные')!;

    await db.run('UPDATE accounts SET initial_balance_minor = ? WHERE id = ?', parseAmount('310000', 'RUB'), card.id);
    await db.run('UPDATE accounts SET initial_balance_minor = ? WHERE id = ?', parseAmount('12000', 'RUB'), cash.id);

    const categories = await db.all<{ id: string; name: string; kind: string }>(
      'SELECT id, name, kind FROM categories WHERE budget_id = ?', budgetId,
    );
    const byName = new Map(categories.map((c) => [c.name, c]));

    const insertTx = async (
      type: string, accountId: string, categoryId: string | null,
      amountMinor: number, currency: string, occurredOn: string,
      note: string | null, actor: string,
    ) => {
      const conv = await convertToBase(amountMinor, currency, 'RUB', occurredOn);
      await db.run(
        `INSERT INTO transactions (
           id, budget_id, type, account_id, counter_account_id, category_id,
           amount_minor, currency, base_amount_minor, base_currency,
           rate_num, rate_den, rate_date, rate_source,
           counter_amount_minor, counter_currency,
           occurred_on, note, created_by, updated_by, created_at, updated_at, version
         ) VALUES (?,?,?,?,NULL,?,?,?,?,'RUB',?,?,?,?,NULL,NULL,?,?,?,?,?,?,1)`,
        newId(), budgetId, type, accountId, categoryId,
        amountMinor, currency, conv.baseAmountMinor,
        conv.rateNum, conv.rateDen, conv.rateDate, conv.rateSource,
        occurredOn, note, actor, actor, ts, ts,
      );
    };

    const today = new Date();
    for (let monthsAgo = 5; monthsAgo >= 0; monthsAgo--) {
      const monthStart = new Date(today.getFullYear(), today.getMonth() - monthsAgo, 1);
      const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
      const maxDay = monthsAgo === 0 ? today.getDate() : daysInMonth;
      const iso = (day: number) =>
        `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

      // Зарплаты обоих участников
      await insertTx('income', card.id, byName.get('Зарплата')!.id,
        parseAmount(String(randomBetween(180000, 195000)), 'RUB'), 'RUB', iso(5), 'Зарплата', owner);
      await insertTx('income', card.id, byName.get('Зарплата')!.id,
        parseAmount(String(randomBetween(120000, 135000)), 'RUB'), 'RUB', iso(10), 'Зарплата', partner);
      if (monthsAgo % 2 === 0) {
        await insertTx('income', card.id, byName.get('Подработка')!.id,
          parseAmount(String(randomBetween(15000, 40000)), 'RUB'), 'RUB', iso(18), 'Проект', owner);
      }

      // Снятие наличных — иначе наличный счёт уходит в минус, чего в жизни не бывает.
      const withdrawal = parseAmount(String(randomBetween(20000, 30000)), 'RUB');
      await db.run(
        `INSERT INTO transactions (
           id, budget_id, type, account_id, counter_account_id, category_id,
           amount_minor, currency, base_amount_minor, base_currency,
           rate_num, rate_den, rate_date, rate_source,
           counter_amount_minor, counter_currency,
           occurred_on, note, created_by, updated_by, created_at, updated_at, version
         ) VALUES (?,?, 'transfer', ?, ?, NULL, ?, 'RUB', ?, 'RUB', 1, 1, ?, 'identity', ?, 'RUB', ?, ?, ?, ?, ?, ?, 1)`,
        newId(), budgetId, card.id, cash.id, withdrawal, withdrawal,
        iso(6), withdrawal, iso(6), 'Снятие наличных', owner, owner, ts, ts,
      );

      for (const [categoryName, note, min, max, count] of PATTERNS) {
        const category = byName.get(categoryName);
        if (!category) continue;
        for (let i = 0; i < count; i++) {
          const day = Math.min(maxDay, randomBetween(1, daysInMonth));
          // Наличными платят за мелочи, а не за аренду. Без этого ограничения
        // случайный выбор счёта отправлял в наличные крупные регулярные
        // платежи, и кошелёк уходил в глубокий минус — чего в жизни не бывает.
        const account = max <= 3000 && Math.random() < 0.35 ? cash : card;
          await insertTx('expense', account.id, category.id,
            parseAmount(String(randomBetween(min, max)), 'RUB'), 'RUB',
            iso(day), note || null, Math.random() < 0.4 ? partner : owner);
        }
      }

      // Расход в валюте — на валютном счёте
      await insertTx('expense', usdAccount, byName.get('Техника')!.id,
        parseAmount(String(randomBetween(20, 180)), 'USD'), 'USD', iso(Math.min(maxDay, 14)),
        'Онлайн-сервисы', owner);
    }

    // Лимиты на текущий месяц
    const period = new Date().toISOString().slice(0, 7);
    for (const [name, limit] of [
      ['Продукты', '35000'], ['Кафе и рестораны', '20000'],
      ['Транспорт', '15000'], ['Развлечения', '8000'],
    ] as const) {
      const category = byName.get(name);
      if (!category) continue;
      await db.run(
        `INSERT INTO budget_limits (id, budget_id, category_id, period, limit_minor, currency,
                                    created_at, updated_at, version)
         VALUES (?,?,?,?,?, 'RUB', ?, ?, 1)`,
        newId(), budgetId, category.id, period, parseAmount(limit, 'RUB'), ts, ts,
      );
    }

    await db.run(
      `INSERT INTO goals (id, budget_id, name, target_minor, saved_minor, currency, due_on,
                          icon, color, created_at, updated_at, version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
      newId(), budgetId, 'Подушка безопасности',
      parseAmount('600000', 'RUB'), parseAmount('415000', 'RUB'), 'RUB', null,
      'savings', '#12a2a0', ts, ts,
    );
    await db.run(
      `INSERT INTO goals (id, budget_id, name, target_minor, saved_minor, currency, due_on,
                          icon, color, created_at, updated_at, version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
      newId(), budgetId, 'Отпуск летом',
      parseAmount('250000', 'RUB'), parseAmount('82000', 'RUB'), 'RUB', null,
      'ticket', '#e0940e', ts, ts,
    );

    // default_budget_id обновляется владельцем только себе — второму
    // участнику это делается ниже, от его имени.
    await db.run('UPDATE user_settings SET default_budget_id = ? WHERE user_id = ?', budgetId, owner);
    createdBudgetId = budgetId;
  }, owner);   // актор для RLS: данные бюджета заводятся от имени владельца

  await db.tx(
    () => db.run('UPDATE user_settings SET default_budget_id = ? WHERE user_id = ?', createdBudgetId, partner),
    partner,
  );

  // Считаем от имени владельца: без актора RLS отдаст ноль, и отчёт
  // о результате врал бы, хотя данные на месте.
  const count = (await db.tx(
    () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions'),
    owner,
  ))!.n;
  console.log(`Демо-данные готовы: ${count} операций.`);
  console.log('Вход: ivan@example.com / demo12345  (владелец)');
  console.log('      anna@example.com / demo12345  (участник)');
  await db.close();
}

void main();
