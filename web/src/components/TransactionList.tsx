import { useMemo } from 'react';
import { formatMoney, type Transaction } from '@checkbudget/shared';
import { useApp, useLookups } from '../data/hooks.js';
import { CategoryDot } from './ui.js';
import { Icon } from './Icon.js';
import { formatDay } from '../lib/dates.js';

/**
 * Операции таблицей.
 *
 * В семейном бюджете у строки пять признаков — когда, что, откуда, кто
 * и сколько, — и все пять сравниваются между строками: «кто это потратил»
 * читается только в колонке, а подписью под названием не читается вовсе.
 *
 * На узком экране колонки «когда», «счёт» и «кто» прячутся и собираются
 * в подпись под названием: на телефоне сравнивать всё равно нечем, зато
 * место есть только под два столбца.
 */
export function TransactionList({
  items, onSelect, emptyState, compact,
}: {
  items: Transaction[];
  onSelect?: (tx: Transaction) => void;
  emptyState?: React.ReactNode;
  /** Узкая колонка: колонки складываются в подпись независимо от ширины окна. */
  compact?: boolean;
}) {
  const { categoryById, accountById } = useLookups();
  const app = useApp();
  const baseCurrency = app.data?.budget.baseCurrency ?? 'RUB';

  const memberById = useMemo(
    () => new Map((app.data?.members ?? []).map((m) => [m.userId, m.displayName])),
    [app.data?.members],
  );

  const groups = useMemo(() => {
    const byDay = new Map<string, Transaction[]>();
    for (const tx of items) {
      const list = byDay.get(tx.occurredOn);
      if (list) list.push(tx);
      else byDay.set(tx.occurredOn, [tx]);
    }
    return [...byDay.entries()];
  }, [items]);

  if (items.length === 0) return <>{emptyState}</>;

  return (
    <table className={`txtable ${compact ? 'txtable--compact' : ''}`}>
      <thead>
        <tr>
          <th className="txtable__hide-sm">Когда</th>
          <th>Категория</th>
          <th className="txtable__hide-sm">Комментарий</th>
          <th className="txtable__hide-sm">Счёт</th>
          <th className="txtable__hide-sm">Кто</th>
          <th>Сумма</th>
        </tr>
      </thead>

      {groups.map(([day, dayItems]) => {
        // Итог дня считается в базовой валюте: складывать разные валюты
        // нельзя, поэтому берутся только конвертированные суммы.
        const total = dayItems.reduce((sum, tx) => {
          if (tx.type === 'transfer' || tx.baseAmountMinor === null) return sum;
          return sum + (tx.type === 'income' ? tx.baseAmountMinor : -tx.baseAmountMinor);
        }, 0);

        return (
          <tbody key={day}>
            <tr className="txtable__day">
              <td colSpan={5}>{formatDay(day)}</td>
              <td className={total > 0 ? 'tone-income' : ''}>
                {total === 0 ? '' : formatMoney(total, baseCurrency, { sign: total > 0 })}
              </td>
            </tr>

            {dayItems.map((tx) => {
              const category = tx.categoryId ? categoryById.get(tx.categoryId) : null;
              const account = accountById.get(tx.accountId);
              const counter = tx.counterAccountId ? accountById.get(tx.counterAccountId) : null;
              const pending = (tx as Transaction & { pending?: boolean }).pending;
              const highlighted = Boolean(app.highlighted[tx.id] && Date.now() - app.highlighted[tx.id]! < 2000);

              const title = tx.type === 'transfer'
                ? `${account?.name ?? '—'} → ${counter?.name ?? '—'}`
                : category?.name ?? 'Без категории';
              const who = memberById.get(tx.createdBy) ?? '—';
              const showsOriginal = tx.currency !== baseCurrency;

              return (
                <tr
                  key={tx.id}
                  className={`${onSelect ? 'is-clickable' : ''} ${pending ? 'is-pending' : ''} ${highlighted ? 'is-highlighted' : ''}`}
                  onClick={() => onSelect?.(tx)}
                >
                  <td className="txtable__hide-sm">{tx.occurredOn.slice(8, 10)}.{tx.occurredOn.slice(5, 7)}</td>

                  <td>
                    <span className="txtable__name">
                      {tx.type === 'transfer'
                        ? <CategoryDot color="var(--cat-stone)" icon="arrows" size={28} />
                        : <CategoryDot color={category?.color ?? 'var(--cat-stone)'} icon={category?.icon ?? 'tag'} size={28} />}
                      <span style={{ minWidth: 0 }}>
                        {title}
                        {/* Скрытые на телефоне колонки собираются сюда. */}
                        <span className="txtable__meta">
                          {[tx.note, account?.name, who].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </span>
                  </td>

                  <td className="txtable__hide-sm">{tx.note || '—'}</td>
                  <td className="txtable__hide-sm">{account?.name ?? '—'}</td>
                  <td className="txtable__hide-sm">{who}</td>

                  <td className="txtable__amount">
                    {/* Расход набран основным тоном, а не красным: в приложении
                        для контроля расходов красной была бы почти каждая
                        строка, и цвет перестал бы что-либо сообщать. */}
                    <span className={tx.type === 'income' ? 'tone-income' : ''}>
                      {tx.type === 'income' ? '+' : tx.type === 'expense' ? '−' : ''}
                      {formatMoney(tx.amountMinor, tx.currency)}
                    </span>
                    {/* Исходная сумма всегда видна как есть; в базовой валюте —
                        справочно, по замороженному курсу операции. */}
                    {showsOriginal && tx.baseAmountMinor !== null && (
                      <span className="txtable__note">≈ {formatMoney(tx.baseAmountMinor, baseCurrency)}</span>
                    )}
                    {showsOriginal && tx.baseAmountMinor === null && (
                      <span className="txtable__note">нет курса</span>
                    )}
                    {pending && (
                      <span className="txtable__note"><Icon name="clock" size={11} /> отправляется</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        );
      })}
    </table>
  );
}
