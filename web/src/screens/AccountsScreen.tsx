import { useEffect, useMemo, useState } from 'react';
import { formatMoney, parseAmount, toInputValue, CURRENCIES, type Account } from '@checkbudget/shared';
import { store } from '../data/store.js';
import { useApp, useCanEdit } from '../data/hooks.js';
import { Card, CardTitle, EmptyState, Button, Sheet, Field, CategoryDot } from '../components/ui.js';

const TYPES: Array<{ value: Account['type']; label: string; icon: string }> = [
  { value: 'card', label: 'Карта', icon: 'card' },
  { value: 'cash', label: 'Наличные', icon: 'cash' },
  { value: 'bank', label: 'Банковский счёт', icon: 'bank' },
  { value: 'ewallet', label: 'Электронный кошелёк', icon: 'wallet' },
  { value: 'savings', label: 'Накопительный', icon: 'savings' },
];

const iconForType = (type: string): string => TYPES.find((t) => t.value === type)?.icon ?? 'wallet';

export function AccountsScreen() {
  const app = useApp();
  const canEdit = useCanEdit();
  const [editing, setEditing] = useState<Account | 'new' | null>(null);

  const data = app.data;
  const accounts = data?.accounts ?? [];
  const base = data?.budget.baseCurrency ?? 'RUB';

  /** Счета группируются по валюте: складывать разные валюты без курса нельзя. */
  const groups = useMemo(() => {
    const byCurrency = new Map<string, Account[]>();
    for (const account of accounts.filter((a) => !a.isArchived)) {
      const list = byCurrency.get(account.currency);
      if (list) list.push(account);
      else byCurrency.set(account.currency, [account]);
    }
    return [...byCurrency.entries()].sort((a) => (a[0] === base ? -1 : 1));
  }, [accounts, base]);

  const archived = accounts.filter((a) => a.isArchived);

  return (
    <div className="stack">
      {groups.map(([currency, list]) => (
        <Card key={currency}>
          <CardTitle
            action={
              <span className="tnum" style={{ fontSize: 15, fontWeight: 640 }}>
                {formatMoney(list.reduce((s, a) => s + a.balanceMinor, 0), currency)}
              </span>
            }
          >
            {currency === base ? 'Основные счета' : `Счета в ${currency}`}
          </CardTitle>
          {list.map((account) => (
            <button key={account.id} className="list-row" style={{ width: '100%', textAlign: 'left' }}
                    onClick={() => canEdit && setEditing(account)}>
              <CategoryDot color={account.color} icon={iconForType(account.type)} />
              <div className="list-row__body">
                <div className="list-row__title">{account.name}</div>
                <div className="list-row__sub">{TYPES.find((t) => t.value === account.type)?.label}</div>
              </div>
              <span className={`tnum ${account.balanceMinor < 0 ? 'tone-expense' : ''}`}
                    style={{ fontWeight: 620 }}>
                {formatMoney(account.balanceMinor, account.currency)}
              </span>
            </button>
          ))}
        </Card>
      ))}

      {groups.length === 0 && (
        <Card><EmptyState icon="wallet" title="Счетов пока нет" /></Card>
      )}

      {archived.length > 0 && (
        <Card>
          <CardTitle>Архив</CardTitle>
          {archived.map((account) => (
            <button key={account.id} className="list-row" style={{ width: '100%', textAlign: 'left', opacity: 0.6 }}
                    onClick={() => canEdit && setEditing(account)}>
              <CategoryDot color={account.color} icon={iconForType(account.type)} />
              <div className="list-row__body">
                <div className="list-row__title">{account.name}</div>
              </div>
              <span className="tnum">{formatMoney(account.balanceMinor, account.currency)}</span>
            </button>
          ))}
        </Card>
      )}

      {canEdit && (
        <Button variant="secondary" icon="plus" full onClick={() => setEditing('new')}>
          Добавить счёт
        </Button>
      )}

      <AccountSheet account={editing} onClose={() => setEditing(null)} baseCurrency={base} />
    </div>
  );
}

function AccountSheet({
  account, onClose, baseCurrency,
}: { account: Account | 'new' | null; onClose: () => void; baseCurrency: string }) {
  const isNew = account === 'new';
  const existing = account && account !== 'new' ? account : null;

  const [name, setName] = useState('');
  const [type, setType] = useState<Account['type']>('card');
  const [currency, setCurrency] = useState(baseCurrency);
  const [initial, setInitial] = useState('');

  useEffect(() => {
    if (!account) return;
    setName(existing?.name ?? '');
    setType(existing?.type ?? 'card');
    setCurrency(existing?.currency ?? baseCurrency);
    setInitial(existing ? toInputValue(existing.initialBalanceMinor, existing.currency) : '');
  }, [account, existing, baseCurrency]);

  if (!account) return null;

  const save = async () => {
    const initialBalanceMinor = initial.trim() ? parseAmount(initial, currency) : 0;
    if (isNew) {
      await store.saveEntity('accounts', 'POST', { name, type, currency, initialBalanceMinor });
    } else if (existing) {
      await store.saveEntity('accounts', 'PATCH', {
        name, type, initialBalanceMinor, version: existing.version,
      }, existing.id);
    }
    onClose();
  };

  const archive = async () => {
    if (!existing) return;
    await store.saveEntity('accounts', 'PATCH', {
      isArchived: !existing.isArchived, version: existing.version,
    }, existing.id);
    onClose();
  };

  return (
    <Sheet
      open onClose={onClose} title={isNew ? 'Новый счёт' : 'Счёт'}
      footer={
        <>
          {existing && (
            <Button variant="secondary" onClick={archive}>
              {existing.isArchived ? 'Вернуть' : 'В архив'}
            </Button>
          )}
          <Button variant="primary" full onClick={save} disabled={!name.trim()}>Сохранить</Button>
        </>
      }
    >
      <Field label="Название">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)}
               placeholder="Тинькофф, наличные…" autoFocus maxLength={80} />
      </Field>

      <Field label="Тип">
        <select className="select" value={type} onChange={(e) => setType(e.target.value as Account['type'])}>
          {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </Field>

      {/* Валюту счёта нельзя менять после создания: это перевело бы все
          операции счёта в другую валюту, чего сделать корректно нельзя. */}
      <Field
        label="Валюта"
        hint={isNew ? 'Операции по счёту ведутся в этой валюте' : 'Валюту существующего счёта изменить нельзя'}
      >
        <select className="select" value={currency} disabled={!isNew}
                onChange={(e) => setCurrency(e.target.value)}>
          {CURRENCIES.map((c) => (
            <option key={c.code} value={c.code}>{c.code} — {c.nameRu}</option>
          ))}
        </select>
      </Field>

      <Field label={`Начальный остаток, ${currency}`}
             hint="Сколько было на счёте до начала учёта">
        <input className="input" inputMode="decimal" value={initial} placeholder="0"
               onChange={(e) => setInitial(e.target.value.replace(/[^\d.,\s-]/g, ''))} />
      </Field>
    </Sheet>
  );
}
