import { Fragment, useMemo } from 'react';
import { formatMoney, type Transaction } from '@checkbudget/shared';
import { useApp, useLookups } from '../data/hooks.js';
import { CategoryDot } from './ui.js';
import { Icon } from './Icon.js';
import { formatDay } from '../lib/dates.js';

export function TransactionList({
  items, onSelect, emptyState,
}: { items: Transaction[]; onSelect?: (tx: Transaction) => void; emptyState?: React.ReactNode }) {
  const { categoryById, accountById } = useLookups();
  const app = useApp();
  const baseCurrency = app.data?.budget.baseCurrency ?? 'RUB';

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
    <div>
      {groups.map(([day, dayItems]) => {
        // Итог дня считается в базовой валюте: складывать разные валюты нельзя,
        // поэтому берутся только конвертированные суммы.
        const total = dayItems.reduce((sum, tx) => {
          if (tx.type === 'transfer' || tx.baseAmountMinor === null) return sum;
          return sum + (tx.type === 'income' ? tx.baseAmountMinor : -tx.baseAmountMinor);
        }, 0);

        return (
          <Fragment key={day}>
            <div className="tx-day">
              {formatDay(day)}
              <span className={`tnum ${total < 0 ? 'tone-muted' : 'tone-income'}`}>
                {total === 0 ? '' : formatMoney(total, baseCurrency, { sign: total > 0 })}
              </span>
            </div>
            {dayItems.map((tx) => {
              const category = tx.categoryId ? categoryById.get(tx.categoryId) : null;
              const account = accountById.get(tx.accountId);
              const counter = tx.counterAccountId ? accountById.get(tx.counterAccountId) : null;
              const pending = (tx as Transaction & { pending?: boolean }).pending;
              const highlighted = Boolean(app.highlighted[tx.id] && Date.now() - app.highlighted[tx.id]! < 2000);

              const title = tx.type === 'transfer'
                ? `${account?.name ?? '—'} → ${counter?.name ?? '—'}`
                : category?.name ?? 'Без категории';

              const sub = [tx.note, tx.type === 'transfer' ? null : account?.name]
                .filter(Boolean).join(' · ');

              const showsOriginal = tx.currency !== baseCurrency;

              return (
                <button
                  key={tx.id}
                  className={`tx ${pending ? 'is-pending' : ''} ${highlighted ? 'is-highlighted' : ''}`}
                  onClick={() => onSelect?.(tx)}
                >
                  {tx.type === 'transfer'
                    ? <CategoryDot color="#64748b" icon="arrows" />
                    : <CategoryDot color={category?.color ?? '#64748b'} icon={category?.icon ?? 'tag'} />}

                  <span className="tx__body">
                    <span className="tx__title">{title}</span>
                    {sub && <span className="tx__sub">{sub}</span>}
                  </span>

                  <span>
                    <span className={`tx__amount tnum ${
                      tx.type === 'income' ? 'tone-income' : tx.type === 'expense' ? 'tone-expense' : 'tone-muted'
                    }`}>
                      {tx.type === 'income' ? '+' : tx.type === 'expense' ? '−' : ''}
                      {formatMoney(tx.amountMinor, tx.currency)}
                    </span>
                    {/* Исходная сумма всегда видна как есть; в базовой валюте —
                        справочно, по замороженному курсу операции. */}
                    {showsOriginal && tx.baseAmountMinor !== null && (
                      <span className="tx__orig tnum">≈ {formatMoney(tx.baseAmountMinor, baseCurrency)}</span>
                    )}
                    {showsOriginal && tx.baseAmountMinor === null && (
                      <span className="tx__orig">нет курса</span>
                    )}
                    {pending && <span className="tx__orig"><Icon name="clock" size={11} /> отправляется</span>}
                  </span>
                </button>
              );
            })}
          </Fragment>
        );
      })}
    </div>
  );
}
