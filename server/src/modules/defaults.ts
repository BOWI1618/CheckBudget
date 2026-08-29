import { db } from '../db/index.js';
import { newId, nowIso } from '../core/ids.js';

/**
 * Стандартные категории нового бюджета.
 *
 * Это не «системные» неудаляемые сущности, а обычные категории-заготовки:
 * пользователь может переименовать, перекрасить и удалить любую.
 * Навязанная неизменяемая таксономия — частая ошибка финансовых приложений.
 */
/*
 * Цвета берутся из закрытой палитры интерфейса (`--cat-*` в global.css):
 * двенадцать тонов, выровненных по светлоте и насыщенности.
 *
 * Закрытость — не украшение, а условие: этими же цветами раскрашивается
 * кольцо расходов, и произвольный пользовательский цвет рядом с ними
 * превратил бы график в радугу. Соседние по смыслу категории разведены
 * по тону намеренно — в списке рядом не должно оказаться двух почти
 * одинаковых кружков.
 */
interface CategorySeed {
  name: string;
  icon: string;
  color: string;
  children?: string[];
}

const EXPENSE_SEEDS: CategorySeed[] = [
  { name: 'Продукты', icon: 'cart', color: '#86a828', children: ['Супермаркет', 'Рынок'] },
  { name: 'Кафе и рестораны', icon: 'coffee', color: '#a9714f', children: ['Кофе', 'Обеды', 'Доставка'] },
  { name: 'Транспорт', icon: 'car', color: '#2b93d8', children: ['Такси', 'Общественный транспорт', 'Автомобиль'] },
  { name: 'Жильё', icon: 'home', color: '#8259d0', children: ['Аренда', 'Коммунальные услуги'] },
  { name: 'Здоровье', icon: 'heart', color: '#e0446b', children: ['Аптека', 'Врачи'] },
  { name: 'Покупки', icon: 'bag', color: '#b34fb0', children: ['Одежда', 'Техника'] },
  { name: 'Развлечения', icon: 'ticket', color: '#ef6b45', children: ['Кино', 'Подписки'] },
  { name: 'Связь и интернет', icon: 'phone', color: '#12a2a0' },
  { name: 'Образование', icon: 'book', color: '#4d6fd4' },
  { name: 'Прочее', icon: 'dots', color: '#6f7a90' },
];

const INCOME_SEEDS: CategorySeed[] = [
  { name: 'Зарплата', icon: 'briefcase', color: '#23a06a' },
  { name: 'Подработка', icon: 'sparkles', color: '#12a2a0' },
  { name: 'Проценты и инвестиции', icon: 'trending', color: '#86a828' },
  { name: 'Подарки', icon: 'gift', color: '#e0940e' },
  { name: 'Прочие поступления', icon: 'dots', color: '#6f7a90' },
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
    newId(), budgetId, 'Карта', 'card', baseCurrency, '#4d6fd4', 'card', ts, ts,
  );
  await db.run(
    `INSERT INTO accounts (id, budget_id, name, type, currency, initial_balance_minor,
                           color, icon, sort_order, created_at, updated_at, version)
     VALUES (?,?,?,?,?,0,?,?,1,?,?,1)`,
    newId(), budgetId, 'Наличные', 'cash', baseCurrency, '#23a06a', 'cash', ts, ts,
  );
}
