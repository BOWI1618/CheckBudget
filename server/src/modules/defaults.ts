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
 * Цвета — закрытая палитра интерфейса (`--cat-*` в global.css).
 *
 * Каждый тон проверен дважды: он даёт ≥4,5:1 и со светлым текстом поверх
 * себя (крупная плитка статьи расхода на сводке), и как текст на светлой
 * карточке (иконка, подпись). Поэтому у категории ОДИН цвет, а не отдельные
 * «для заливки» и «для текста».
 *
 * Закрытость — условие, а не украшение: этими же цветами красятся полосы
 * по величине, и произвольный пользовательский цвет разрушил бы согласие
 * между ними.
 */
interface CategorySeed {
  name: string;
  icon: string;
  color: string;
  children?: string[];
}

const EXPENSE_SEEDS: CategorySeed[] = [
  { name: 'Продукты', icon: 'cart', color: '#487853', children: ['Супермаркет', 'Рынок'] },
  { name: 'Кафе и рестораны', icon: 'coffee', color: '#8d5a35', children: ['Кофе', 'Обеды', 'Доставка'] },
  { name: 'Транспорт', icon: 'car', color: '#34698f', children: ['Такси', 'Общественный транспорт', 'Автомобиль'] },
  { name: 'Жильё', icon: 'home', color: '#6b3f52', children: ['Аренда', 'Коммунальные услуги'] },
  { name: 'Здоровье', icon: 'heart', color: '#c0392b', children: ['Аптека', 'Врачи'] },
  { name: 'Покупки', icon: 'bag', color: '#8f6415', children: ['Одежда', 'Техника'] },
  { name: 'Развлечения', icon: 'ticket', color: '#a8451c', children: ['Кино', 'Подписки'] },
  { name: 'Связь и интернет', icon: 'phone', color: '#2d6b68' },
  { name: 'Образование', icon: 'book', color: '#3d52a0' },
  { name: 'Прочее', icon: 'dots', color: '#7a6a5c' },
];

const INCOME_SEEDS: CategorySeed[] = [
  { name: 'Зарплата', icon: 'briefcase', color: '#2f6b3f' },
  { name: 'Подработка', icon: 'sparkles', color: '#2d6b68' },
  { name: 'Проценты и инвестиции', icon: 'trending', color: '#5f6b2a' },
  { name: 'Подарки', icon: 'gift', color: '#8f6415' },
  { name: 'Прочие поступления', icon: 'dots', color: '#7a6a5c' },
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
    newId(), budgetId, 'Карта', 'card', baseCurrency, '#3d52a0', 'card', ts, ts,
  );
  await db.run(
    `INSERT INTO accounts (id, budget_id, name, type, currency, initial_balance_minor,
                           color, icon, sort_order, created_at, updated_at, version)
     VALUES (?,?,?,?,?,0,?,?,1,?,?,1)`,
    newId(), budgetId, 'Наличные', 'cash', baseCurrency, '#2f6b3f', 'cash', ts, ts,
  );
}
