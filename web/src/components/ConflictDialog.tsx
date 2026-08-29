import { formatMoney } from '@checkbudget/shared';
import { store } from '../data/store.js';
import { useApp } from '../data/hooks.js';
import { Sheet, Button } from '../components/ui.js';
import { Icon } from './Icon.js';
import { formatDay } from '../lib/dates.js';

const FIELD_LABEL: Record<string, string> = {
  amountMinor: 'Сумма',
  occurredOn: 'Дата',
  note: 'Комментарий',
  categoryId: 'Категория',
  accountId: 'Счёт',
};

/**
 * Диалог показывается ТОЛЬКО когда два участника изменили одно и то же поле.
 * Непересекающиеся правки сливаются автоматически и пользователю не мешают.
 *
 * Ключевое требование: ни один из вариантов не должен пропасть молча —
 * человек видит оба значения и выбирает сам.
 */
export function ConflictDialog() {
  const app = useApp();
  const conflict = app.conflict;
  if (!conflict) return null;

  const currency = (conflict.theirs.currency as string) ?? app.data?.budget.baseCurrency ?? 'RUB';

  const render = (source: Record<string, unknown>, field: string): string => {
    const value = source[field];
    if (value === null || value === undefined) return '—';
    if (field === 'amountMinor') return formatMoney(Number(value), currency);
    if (field === 'occurredOn') return formatDay(String(value));
    if (field === 'note') return String(value) || '—';
    return String(value);
  };

  return (
    <Sheet
      open onClose={() => store.keepTheirs()} title="Операцию изменил другой участник"
      footer={
        <>
          <Button variant="secondary" full onClick={() => store.keepTheirs()}>
            Оставить как есть
          </Button>
          <Button variant="primary" full onClick={() => store.keepMine()}>
            Записать моё
          </Button>
        </>
      }
    >
      <div className="banner banner--offline">
        <Icon name="warning" size={16} />
        Пока вы редактировали, кто-то изменил эту же операцию. Ваше изменение
        не применено и не потеряно — выберите, что оставить.
      </div>

      {conflict.fields.map((field) => (
        <div className="stack" key={field} style={{ gap: 8 }}>
          <span className="field__label">{FIELD_LABEL[field] ?? field}</span>
          <div className="conflict-option">
            <span>Сейчас в бюджете</span>
            <strong className="money">{render(conflict.theirs, field)}</strong>
          </div>
          <div className="conflict-option" style={{ borderColor: 'var(--accent)' }}>
            <span>Ваше изменение</span>
            <strong className="money">{render(conflict.mine, field)}</strong>
          </div>
        </div>
      ))}
    </Sheet>
  );
}
