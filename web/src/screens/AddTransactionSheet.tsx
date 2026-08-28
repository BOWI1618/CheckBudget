import { useEffect, useMemo, useState } from 'react';
import { formatMoney, parseAmount, toInputValue, getCurrency, type Transaction } from '@checkbudget/shared';
import { store } from '../data/store.js';
import { useApp, useCategoryTree, useLookups } from '../data/hooks.js';
import { Sheet, Button, Field, Segmented } from '../components/ui.js';
import { Icon } from '../components/Icon.js';
import { todayIso } from '../lib/dates.js';

type Kind = 'expense' | 'income' | 'transfer';

/**
 * Главная форма приложения. Добавление расхода — 90% всех действий,
 * поэтому здесь оптимизируется количество касаний, а не полнота полей:
 * сумма и категория обязательны, остальное подставлено по умолчанию
 * и раскрывается по запросу.
 */
export function AddTransactionSheet({
  open, onClose, editing,
}: { open: boolean; onClose: () => void; editing?: Transaction | null }) {
  const app = useApp();
  const data = app.data;
  const { accountById } = useLookups();

  const [kind, setKind] = useState<Kind>('expense');
  const [amount, setAmount] = useState('');
  const [counterAmount, setCounterAmount] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [counterAccountId, setCounterAccountId] = useState<string | null>(null);
  const [occurredOn, setOccurredOn] = useState(todayIso());
  const [note, setNote] = useState('');
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tree = useCategoryTree(kind === 'income' ? 'income' : 'expense');
  const accounts = useMemo(() => (data?.accounts ?? []).filter((a) => !a.isArchived), [data?.accounts]);
  const account = accountId ? accountById.get(accountId) : accounts[0];
  const currency = account?.currency ?? data?.budget.baseCurrency ?? 'RUB';
  const counterAccount = counterAccountId ? accountById.get(counterAccountId) : null;

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (editing) {
      setKind(editing.type as Kind);
      setAmount(toInputValue(editing.amountMinor, editing.currency));
      setCounterAmount(editing.counterAmountMinor && editing.counterCurrency
        ? toInputValue(editing.counterAmountMinor, editing.counterCurrency) : '');
      setCategoryId(editing.categoryId);
      setAccountId(editing.accountId);
      setCounterAccountId(editing.counterAccountId);
      setOccurredOn(editing.occurredOn);
      setNote(editing.note ?? '');
      setShowMore(true);
    } else {
      setKind('expense');
      setAmount('');
      setCounterAmount('');
      setCategoryId(null);
      setNote('');
      setOccurredOn(todayIso());
      setShowMore(false);
      // Последний использованный счёт — самая частая подстановка,
      // которая экономит одно касание почти всегда.
      const lastUsed = data?.transactions[0]?.accountId;
      setAccountId(lastUsed && accounts.some((a) => a.id === lastUsed) ? lastUsed : accounts[0]?.id ?? null);
      setCounterAccountId(accounts[1]?.id ?? null);
    }
  }, [open, editing, data?.transactions, accounts]);

  /**
   * Частые категории — по фактической частоте использования конкретным
   * бюджетом за последние 60 дней. Список подстраивается под человека,
   * а не под алфавит.
   */
  const frequent = useMemo(() => {
    if (!data || kind === 'transfer') return [];
    const cutoff = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
    const counts = new Map<string, number>();
    for (const tx of data.transactions) {
      if (tx.type !== kind || !tx.categoryId || tx.occurredOn < cutoff) continue;
      counts.set(tx.categoryId, (counts.get(tx.categoryId) ?? 0) + 1);
    }
    const byId = new Map(data.categories.map((c) => [c.id, c]));
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
      .map(([id]) => byId.get(id)).filter(Boolean).slice(0, 8);
    if (ranked.length >= 4) return ranked as typeof data.categories;
    // Пока истории мало — показываем корневые категории.
    const fallback = data.categories.filter((c) => c.kind === kind && !c.parentId);
    return [...new Set([...(ranked as typeof data.categories), ...fallback])].slice(0, 8);
  }, [data, kind]);

  if (!data) return null;

  const amountMinor = (() => {
    try {
      return amount ? parseAmount(amount, currency) : 0;
    } catch {
      return 0;
    }
  })();

  const crossCurrency = kind === 'transfer' && counterAccount && counterAccount.currency !== currency;

  const canSave = amountMinor > 0
    && !!accountId
    && (kind === 'transfer'
      ? !!counterAccountId && counterAccountId !== accountId && (!crossCurrency || counterAmount !== '')
      : !!categoryId);

  const submit = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);

    const payload: Record<string, unknown> = {
      type: kind,
      accountId,
      categoryId: kind === 'transfer' ? null : categoryId,
      counterAccountId: kind === 'transfer' ? counterAccountId : null,
      amountMinor,
      currency,
      counterAmountMinor: crossCurrency && counterAccount
        ? parseAmount(counterAmount, counterAccount.currency) : null,
      occurredOn,
      note: note.trim() || null,
    };

    const ok = editing
      ? await store.updateTransaction(editing.id, payload, editing)
      : (await store.addTransaction(payload)) !== null;

    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? 'Изменить операцию' : 'Новая операция'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} full>Отмена</Button>
          <Button variant="primary" onClick={submit} disabled={!canSave || busy} full>
            {busy ? 'Сохраняем…' : editing ? 'Сохранить' : 'Добавить'}
          </Button>
        </>
      }
    >
      {!editing && (
        <Segmented<Kind>
          value={kind}
          onChange={(v) => { setKind(v); setCategoryId(null); }}
          options={[
            { value: 'expense', label: 'Расход', tone: 'expense' },
            { value: 'income', label: 'Доход', tone: 'income' },
            { value: 'transfer', label: 'Перевод' },
          ]}
        />
      )}

      <div className="amount-input">
        <input
          inputMode="decimal" autoFocus={!editing} value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.,\s]/g, ''))}
          placeholder="0" aria-label="Сумма"
        />
        <span className="amount-input__cur">{getCurrency(currency).symbol}</span>
      </div>

      {kind !== 'transfer' && (
        <Field label="Категория">
          <div className="chips">
            {frequent.map((category) => (
              <button
                key={category.id} type="button"
                className={`chip ${categoryId === category.id ? 'is-active' : ''}`}
                onClick={() => setCategoryId(category.id)}
              >
                <Icon name={category.icon} size={16} />
                {category.name}
              </button>
            ))}
          </div>
          <select className="select" value={categoryId ?? ''} style={{ marginTop: 8 }}
                  onChange={(e) => setCategoryId(e.target.value || null)}>
            <option value="">Все категории…</option>
            {tree.map((root) => (
              <optgroup key={root.id} label={root.name}>
                <option value={root.id}>{root.name} — общее</option>
                {root.children.map((child) => (
                  <option key={child.id} value={child.id}>{child.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
      )}

      <Field label={kind === 'transfer' ? 'Откуда' : 'Счёт'}>
        <select className="select" value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {formatMoney(a.balanceMinor, a.currency)}
            </option>
          ))}
        </select>
      </Field>

      {kind === 'transfer' && (
        <>
          <Field label="Куда">
            <select className="select" value={counterAccountId ?? ''}
                    onChange={(e) => setCounterAccountId(e.target.value)}>
              {accounts.filter((a) => a.id !== accountId).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {formatMoney(a.balanceMinor, a.currency)}
                </option>
              ))}
            </select>
          </Field>
          {crossCurrency && counterAccount && (
            <Field
              label={`Сумма зачисления, ${counterAccount.currency}`}
              hint="Курс перевода задаёт банк, поэтому обе суммы указываются явно"
            >
              <input className="input" inputMode="decimal" value={counterAmount}
                     onChange={(e) => setCounterAmount(e.target.value.replace(/[^\d.,\s]/g, ''))} />
            </Field>
          )}
        </>
      )}

      {showMore ? (
        <>
          <Field label="Дата">
            <input className="input" type="date" value={occurredOn} max="2100-01-01"
                   onChange={(e) => setOccurredOn(e.target.value)} />
          </Field>
          <Field label="Комментарий">
            <input className="input" value={note} maxLength={500} placeholder="Необязательно"
                   onChange={(e) => setNote(e.target.value)} />
          </Field>
        </>
      ) : (
        <Button variant="ghost" icon="chevronDown" onClick={() => setShowMore(true)}>
          Дата и комментарий
        </Button>
      )}

      {error && <div className="banner banner--error">{error}</div>}
    </Sheet>
  );
}
