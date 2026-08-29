import { useMemo, useState } from 'react';
import type { Transaction } from '@checkbudget/shared';
import { formatMoney } from '@checkbudget/shared';
import { useApp, useCanEdit, useLookups } from '../data/hooks.js';
import { store } from '../data/store.js';
import { Card, CardTitle, EmptyState, Button, Sheet, Segmented } from '../components/ui.js';
import { TransactionList } from '../components/TransactionList.js';
import { Icon } from '../components/Icon.js';
import { periodBounds, formatDay } from '../lib/dates.js';

type Filter = 'all' | 'expense' | 'income' | 'transfer';

export function TransactionsScreen({
  period, onEdit, onAdd,
}: { period: string; onEdit: (tx: Transaction) => void; onAdd: () => void }) {
  const app = useApp();
  const canEdit = useCanEdit();
  const { categoryById, accountById, memberById } = useLookups();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Transaction | null>(null);

  const items = useMemo(() => {
    const data = app.data;
    if (!data) return [];
    const { from, to } = periodBounds(period);
    const needle = query.trim().toLowerCase();
    return data.transactions.filter((tx) => {
      if (tx.occurredOn < from || tx.occurredOn > to) return false;
      if (filter !== 'all' && tx.type !== filter) return false;
      if (!needle) return true;
      const category = tx.categoryId ? categoryById.get(tx.categoryId)?.name ?? '' : '';
      return `${tx.note ?? ''} ${category}`.toLowerCase().includes(needle);
    });
  }, [app.data, period, filter, query, categoryById]);

  const total = items.reduce((sum, tx) => {
    if (tx.type === 'transfer' || tx.baseAmountMinor === null) return sum;
    return sum + (tx.type === 'income' ? tx.baseAmountMinor : -tx.baseAmountMinor);
  }, 0);

  const base = app.data?.budget.baseCurrency ?? 'RUB';

  return (
    <div className="stack">
      <Card>
        <div className="stack" style={{ gap: 10 }}>
          <div className="search">
            <Icon name="search" size={17} />
            <input
              className="input" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по комментарию или категории" aria-label="Поиск операций"
            />
          </div>
          <Segmented<Filter>
            value={filter} onChange={setFilter}
            options={[
              { value: 'all', label: 'Все' },
              { value: 'expense', label: 'Расходы', tone: 'expense' },
              { value: 'income', label: 'Доходы', tone: 'income' },
              { value: 'transfer', label: 'Переводы' },
            ]}
          />
        </div>
      </Card>

      <Card>
        <CardTitle action={<span className="money" style={{ fontSize: 14, fontWeight: 620 }}>
          {formatMoney(total, base, { sign: total > 0 })}
        </span>}>
          {items.length} операц.
        </CardTitle>
        <TransactionList
          items={items}
          onSelect={setSelected}
          emptyState={
            <EmptyState
              icon="list"
              title={query ? 'Ничего не найдено' : 'Операций пока нет'}
              text={query ? 'Попробуйте изменить запрос' : 'Добавьте первую — это займёт несколько секунд'}
              action={!query && canEdit
                ? <Button variant="primary" icon="plus" onClick={onAdd}>Добавить операцию</Button> : undefined}
            />
          }
        />
      </Card>

      <TransactionDetails
        tx={selected}
        onClose={() => setSelected(null)}
        onEdit={(tx) => { setSelected(null); onEdit(tx); }}
        canEdit={canEdit}
        categoryName={selected?.categoryId ? categoryById.get(selected.categoryId)?.name ?? null : null}
        accountName={selected ? accountById.get(selected.accountId)?.name ?? null : null}
        counterName={selected?.counterAccountId ? accountById.get(selected.counterAccountId)?.name ?? null : null}
        authorName={selected ? memberById.get(selected.createdBy)?.displayName ?? null : null}
        baseCurrency={base}
      />
    </div>
  );
}

function TransactionDetails({
  tx, onClose, onEdit, canEdit, categoryName, accountName, counterName, authorName, baseCurrency,
}: {
  tx: Transaction | null;
  onClose: () => void;
  onEdit: (tx: Transaction) => void;
  canEdit: boolean;
  categoryName: string | null;
  accountName: string | null;
  counterName: string | null;
  authorName: string | null;
  baseCurrency: string;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!tx) return null;

  const rows: Array<[string, string]> = [
    ['Дата', formatDay(tx.occurredOn)],
    ['Счёт', tx.type === 'transfer' ? `${accountName} → ${counterName}` : accountName ?? '—'],
  ];
  if (categoryName) rows.splice(1, 0, ['Категория', categoryName]);
  if (tx.note) rows.push(['Комментарий', tx.note]);
  if (authorName) rows.push(['Добавил', authorName]);

  // Всё, что нужно для воспроизведения расчёта, показывается пользователю:
  // курс, дата курса и источник. Иначе конвертация выглядит магией.
  if (tx.currency !== baseCurrency && tx.rateNum && tx.rateDen) {
    rows.push(['Курс', `1 ${tx.currency} = ${(tx.rateNum / tx.rateDen).toFixed(4).replace('.', ',')} ${baseCurrency}`]);
    if (tx.rateDate) rows.push(['Курс на дату', formatDay(tx.rateDate)]);
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Операция"
      footer={canEdit ? (
        confirming ? (
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)} full>Отмена</Button>
            <Button variant="danger" full onClick={async () => {
              await store.deleteTransaction(tx.id, tx.version);
              onClose();
            }}>
              Удалить операцию
            </Button>
          </>
        ) : (
          <>
            <Button variant="danger" icon="trash" onClick={() => setConfirming(true)}>Удалить</Button>
            <Button variant="primary" icon="edit" full onClick={() => onEdit(tx)}>Изменить</Button>
          </>
        )
      ) : undefined}
    >
      <div style={{ textAlign: 'center', padding: '6px 0 10px' }}>
        <div className={`money ${tx.type === 'income' ? 'tone-income' : tx.type === 'expense' ? 'tone-expense' : ''}`}
             style={{ fontSize: 36, fontWeight: 700, letterSpacing: '-0.03em' }}>
          {tx.type === 'income' ? '+' : tx.type === 'expense' ? '−' : ''}
          {formatMoney(tx.amountMinor, tx.currency)}
        </div>
        {tx.currency !== baseCurrency && tx.baseAmountMinor !== null && (
          <div className="tone-muted tnum" style={{ fontSize: 14 }}>
            ≈ {formatMoney(tx.baseAmountMinor, baseCurrency)}
          </div>
        )}
      </div>

      <div>
        {rows.map(([label, value]) => (
          <div className="list-row" key={label}>
            <span className="list-row__body list-row__sub">{label}</span>
            <span style={{ fontSize: 14, fontWeight: 520, textAlign: 'right' }}>{value}</span>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
