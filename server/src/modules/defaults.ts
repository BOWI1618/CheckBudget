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
 * Палитра приглушённая и одного семейства.
 *
 * Раньше здесь стояли насыщенные цвета вроде #8b5cf6 и #f97316: рядом
 * с чернильной палитрой интерфейса они выглядели как виджет из другого
 * приложения. Категорию всё равно опознают по названию и значку, а цвет
 * должен лишь различать соседние строки, не крича.
 */
interface CategorySeed {
  name: string;
  icon: string;
  color: string;
  children?: string[];
}

const EXPENSE_SEEDS: CategorySeed[] = [
  { name: 'Продукты', icon: 'cart', color: '#4b7f6a', children: ['Супермаркет', 'Рынок'] },
  { name: 'Кафе и рестораны', icon: 'coffee', color: '#a8724a', children: ['Кофе', 'Обеды', 'Доставка'] },
  { name: 'Транспорт', icon: 'car', color: '#4a6a94', children: ['Такси', 'Общественный транспорт', 'Автомобиль'] },
  { name: 'Жильё', icon: 'home', color: '#6b5f8a', children: ['Аренда', 'Коммунальные услуги'] },
  { name: 'Здоровье', icon: 'heart', color: '#a35c5c', children: ['Аптека', 'Врачи'] },
  { name: 'Покупки', icon: 'bag', color: '#8a5f78', children: ['Одежда', 'Техника'] },
  { name: 'Развлечения', icon: 'ticket', color: '#7a6a3f', children: ['Кино', 'Подписки'] },
  { name: 'Связь и интернет', icon: 'phone', color: '#47788a' },
  { name: 'Образование', icon: 'book', color: '#5a6e8c' },
  { name: 'Прочее', icon: 'dots', color: '#6c7480' },
];

const INCOME_SEEDS: CategorySeed[] = [
  { name: 'Зарплата', icon: 'briefcase', color: '#3d7a5c' },
  { name: 'Подработка', icon: 'sparkles', color: '#4f7f74' },
  { name: 'Проценты и инвестиции', icon: 'trending', color: '#5f7a4a' },
  { name: 'Подарки', icon: 'gift', color: '#97733f' },
  { name: 'Прочие поступления', icon: 'dots', color: '#6c7480' },
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
    newId(), budgetId, 'Карта', 'card', baseCurrency, '#4a6a94', 'card', ts, ts,
  );
  await db.run(
    `INSERT INTO accounts (id, budget_id, name, type, currency, initial_balance_minor,
                           color, icon, sort_order, created_at, updated_at, version)
     VALUES (?,?,?,?,?,0,?,?,1,?,?,1)`,
    newId(), budgetId, 'Наличные', 'cash', baseCurrency, '#4b7f6a', 'cash', ts, ts,
  );
}
