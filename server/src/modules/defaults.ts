import { db } from '../db/index.js';
import { newId, nowIso } from '../core/ids.js';

/**
 * Стандартные категории нового бюджета.
 *
 * Это не «системные» неудаляемые сущности, а обычные категории-заготовки:
 * пользователь может переименовать, перекрасить и удалить любую.
 * Навязанная неизменяемая таксономия — частая ошибка финансовых приложений.
 */
interface CategorySeed {
  name: string;
  icon: string;
  color: string;
  children?: string[];
}

const EXPENSE_SEEDS: CategorySeed[] = [
  { name: 'Продукты', icon: 'cart', color: '#22c55e', children: ['Супермаркет', 'Рынок'] },
  { name: 'Кафе и рестораны', icon: 'coffee', color: '#f97316', children: ['Кофе', 'Обеды', 'Доставка'] },
  { name: 'Транспорт', icon: 'car', color: '#3b82f6', children: ['Такси', 'Общественный транспорт', 'Автомобиль'] },
  { name: 'Жильё', icon: 'home', color: '#8b5cf6', children: ['Аренда', 'Коммунальные услуги'] },
  { name: 'Здоровье', icon: 'heart', color: '#ef4444', children: ['Аптека', 'Врачи'] },
  { name: 'Покупки', icon: 'bag', color: '#ec4899', children: ['Одежда', 'Техника'] },
  { name: 'Развлечения', icon: 'ticket', color: '#a855f7', children: ['Кино', 'Подписки'] },
  { name: 'Связь и интернет', icon: 'phone', color: '#06b6d4' },
  { name: 'Образование', icon: 'book', color: '#0ea5e9' },
  { name: 'Прочее', icon: 'dots', color: '#64748b' },
];

const INCOME_SEEDS: CategorySeed[] = [
  { name: 'Зарплата', icon: 'briefcase', color: '#10b981' },
  { name: 'Подработка', icon: 'sparkles', color: '#14b8a6' },
  { name: 'Проценты и инвестиции', icon: 'trending', color: '#84cc16' },
  { name: 'Подарки', icon: 'gift', color: '#f59e0b' },
  { name: 'Прочие поступления', icon: 'dots', color: '#64748b' },
];

export async function seedBudgetDefaults(budgetId: string, baseCurrency: string): Promise<void> {
  const ts = nowIso();
  let order = 0;

  const insert = async (
    id: string, parentId: string | null, name: string, kind: 'expense' | 'income',
    icon: string, color: string,
  ) => {
    await db.run(
      `INSERT INTO categories (id, budget_id, parent_id, name, kind, icon, color,
                               sort_order, created_at, updated_at, version)
       VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
      id, budgetId, parentId, name, kind, icon, color, order++, ts, ts,
    );
  };

  for (const [kind, seeds] of [['expense', EXPENSE_SEEDS], ['income', INCOME_SEEDS]] as const) {
    for (const seed of seeds) {
      const parentId = newId();
      await insert(parentId, null, seed.name, kind, seed.icon, seed.color);
      for (const child of seed.children ?? []) {
        await insert(newId(), parentId, child, kind, seed.icon, seed.color);
      }
    }
  }

  // Два счёта по умолчанию покрывают подавляющее большинство сценариев
  // и снимают барьер «сначала настрой, потом пользуйся».
  await db.run(
    `INSERT INTO accounts (id, budget_id, name, type, currency, initial_balance_minor,
                           color, icon, sort_order, created_at, updated_at, version)
     VALUES (?,?,?,?,?,0,?,?,0,?,?,1)`,
    newId(), budgetId, 'Карта', 'card', baseCurrency, '#6366f1', 'card', ts, ts,
  );
  await db.run(
    `INSERT INTO accounts (id, budget_id, name, type, currency, initial_balance_minor,
                           color, icon, sort_order, created_at, updated_at, version)
     VALUES (?,?,?,?,?,0,?,?,1,?,?,1)`,
    newId(), budgetId, 'Наличные', 'cash', baseCurrency, '#10b981', 'cash', ts, ts,
  );
}
