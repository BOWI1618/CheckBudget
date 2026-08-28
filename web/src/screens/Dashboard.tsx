import { useMemo } from 'react';
import { formatMoney } from '@checkbudget/shared';
import type { Transaction } from '@checkbudget/shared';
import { useApp, useLookups } from '../data/hooks.js';
import { Card, CardTitle, EmptyState, Button, ProgressBar, Skeleton } from '../components/ui.js';
import { Donut, Legend, GroupedBars, type Slice } from '../components/charts.js';
import { TransactionList } from '../components/TransactionList.js';
import { Icon } from '../components/Icon.js';
import { periodBounds, formatPeriod, lastMonths, shortMonth } from '../lib/dates.js';

export function Dashboard({
  period, onAdd, onSelect, onNavigate,
}: {
  period: string;
  onAdd: () => void;
  onSelect: (tx: Transaction) => void;
  onNavigate: (path: string) => void;
}) {
  const app = useApp();
  const data = app.data;
  const { categoryById } = useLookups();

  const stats = useMemo(() => {
    if (!data) return null;
    const { from, to } = periodBounds(period);
    const base = data.budget.baseCurrency;

    let income = 0;
    let expense = 0;
    let unconverted = 0;
    const byRoot = new Map<string, number>();

    for (const tx of data.transactions) {
      if (tx.occurredOn < from || tx.occurredOn > to || tx.type === 'transfer') continue;
      if (tx.baseAmountMinor === null) { unconverted++; continue; }
      if (tx.type === 'income') { income += tx.baseAmountMinor; continue; }
      expense += tx.baseAmountMinor;

      const category = tx.categoryId ? categoryById.get(tx.categoryId) : null;
      const rootId = category?.parentId ?? category?.id;
      if (rootId) byRoot.set(rootId, (byRoot.get(rootId) ?? 0) + tx.baseAmountMinor);
    }

    // Баланс — сумма всех счетов, приведённая к базовой валюте.
    // Счета в других валютах показываются отдельно на экране «Счета»:
    // складывать их без курса на сегодня было бы неверно.
    const balance = data.accounts
      .filter((a) => !a.isArchived && a.currency === base)
      .reduce((sum, a) => sum + a.balanceMinor, 0);
    const otherCurrencies = data.accounts.filter((a) => !a.isArchived && a.currency !== base).length;

    const slices: Slice[] = [...byRoot.entries()]
      .map(([id, value]) => {
        const category = categoryById.get(id);
        return { id, value, label: category?.name ?? 'Прочее', color: category?.color ?? '#64748b' };
      })
      .sort((a, b) => b.value - a.value);

    const top = slices.slice(0, 5);
    const rest = slices.slice(5);
    if (rest.length > 0) {
      top.push({
        id: 'rest', label: 'Остальное', color: '#94a3b8',
        value: rest.reduce((s, x) => s + x.value, 0),
      });
    }

    // Итоги по месяцам приходят готовыми: считать их из сырых операций
    // значило бы возить год данных ради двенадцати чисел.
    const totals = new Map(data.monthly.map((r) => [r.month, r]));
    const months = lastMonths(6).map((m) => ({
      label: shortMonth(m),
      income: totals.get(m)?.incomeMinor ?? 0,
      expense: totals.get(m)?.expenseMinor ?? 0,
    }));

    return { income, expense, balance, unconverted, slices: top, allSlices: slices, months, otherCurrencies, base };
  }, [data, period, categoryById]);

  const recent = useMemo(() => {
    if (!data) return [];
    const { from, to } = periodBounds(period);
    return data.transactions.filter((t) => t.occurredOn >= from && t.occurredOn <= to).slice(0, 8);
  }, [data, period]);

  const limits = useMemo(
    () => (data?.limits ?? []).filter((l) => l.period === period).slice(0, 4),
    [data?.limits, period],
  );

  if (!data || !stats) {
    return (
      <div className="stack">
        <Card><Skeleton height={92} /></Card>
        <Card><Skeleton height={180} /></Card>
      </div>
    );
  }

  const base = stats.base;
  const budgeted = (data.limits ?? []).filter((l) => l.period === period)
    .reduce((sum, l) => sum + l.limitMinor, 0);
  const spentOnBudgeted = (data.limits ?? []).filter((l) => l.period === period)
    .reduce((sum, l) => sum + l.spentMinor, 0);

  return (
    <div className="stack">
      <Card className="hero">
        <p className="hero__label">Баланс{stats.otherCurrencies > 0 ? ` · ${base}` : ''}</p>
        <p className="hero__value tnum">{formatMoney(stats.balance, base)}</p>
        <div className="hero__split">
          <div className="hero__item">
            <span>Доходы за {formatPeriod(period).toLowerCase()}</span>
            <strong className="tone-income tnum">{formatMoney(stats.income, base)}</strong>
          </div>
          <div className="hero__item">
            <span>Расходы</span>
            <strong className="tone-expense tnum">{formatMoney(stats.expense, base)}</strong>
          </div>
          <div className="hero__item">
            <span>Разница</span>
            <strong className="tnum">{formatMoney(stats.income - stats.expense, base, { sign: stats.income > stats.expense })}</strong>
          </div>
        </div>
        {stats.unconverted > 0 && (
          <div className="banner banner--offline" style={{ marginTop: 14 }}>
            <Icon name="warning" size={16} />
            {stats.unconverted} операц. без курса — не учтены в итогах
          </div>
        )}
      </Card>

      {budgeted > 0 && (
        <Card>
          <CardTitle action={<Button variant="ghost" size="sm" onClick={() => onNavigate('/budgets')}>Все лимиты</Button>}>
            Бюджет на {formatPeriod(period).toLowerCase()}
          </CardTitle>
          <div className="limit__nums" style={{ marginBottom: 8 }}>
            <span className="tnum">Потрачено {formatMoney(spentOnBudgeted, base)}</span>
            <span className="tnum">из {formatMoney(budgeted, base)}</span>
          </div>
          <ProgressBar
            value={(spentOnBudgeted / budgeted) * 100}
            tone={spentOnBudgeted > budgeted ? 'over' : spentOnBudgeted > budgeted * 0.8 ? 'warn' : 'ok'}
          />
          {limits.map((limit) => {
            const category = categoryById.get(limit.categoryId);
            const pct = limit.limitMinor > 0 ? (limit.spentMinor / limit.limitMinor) * 100 : 0;
            return (
              <div className="limit" key={limit.id}>
                <div className="limit__top">
                  <span className="limit__name">{category?.name ?? 'Категория'}</span>
                  <span className={`tnum ${pct > 100 ? 'tone-expense' : 'tone-muted'}`} style={{ fontSize: 13 }}>
                    {Math.round(pct)}%
                  </span>
                </div>
                <ProgressBar value={pct} tone={pct > 100 ? 'over' : pct > 80 ? 'warn' : 'ok'} />
              </div>
            );
          })}
        </Card>
      )}

      <div className="grid-2 grid-2--wide">
        <Card>
          <CardTitle>Структура расходов</CardTitle>
          {stats.slices.length === 0 ? (
            <EmptyState icon="chart" title="Расходов пока нет"
                        text="Добавьте первую операцию — здесь появится разбивка по категориям"
                        action={<Button variant="primary" icon="plus" onClick={onAdd}>Добавить расход</Button>} />
          ) : (
            <div className="row" style={{ gap: 20, flexWrap: 'wrap' }}>
              <Donut slices={stats.slices} currency={base} total={stats.expense} />
              <div style={{ flex: 1, minWidth: 200 }}>
                <Legend slices={stats.slices} currency={base} total={stats.expense} />
              </div>
            </div>
          )}
        </Card>

        <Card>
          <CardTitle>Доходы и расходы</CardTitle>
          <GroupedBars points={stats.months} currency={base} />
          <div className="row" style={{ gap: 16, marginTop: 12, fontSize: 12.5 }}>
            <span className="row" style={{ gap: 6 }}>
              <span className="legend__swatch" style={{ background: 'var(--income)' }} /> доходы
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span className="legend__swatch" style={{ background: 'var(--expense)' }} /> расходы
            </span>
          </div>
        </Card>
      </div>

      {data.goals.length > 0 && (
        <Card>
          <CardTitle>Цели</CardTitle>
          {data.goals.map((goal) => {
            const pct = goal.targetMinor > 0 ? (goal.savedMinor / goal.targetMinor) * 100 : 0;
            return (
              <div className="limit" key={goal.id}>
                <div className="limit__top">
                  <Icon name={goal.icon} size={17} />
                  <span className="limit__name">{goal.name}</span>
                  <span className="tnum tone-muted" style={{ fontSize: 13 }}>{Math.round(pct)}%</span>
                </div>
                <ProgressBar value={pct} tone="ok" />
                <div className="limit__nums">
                  <span className="tnum">{formatMoney(goal.savedMinor, goal.currency)}</span>
                  <span className="tnum">из {formatMoney(goal.targetMinor, goal.currency)}</span>
                </div>
              </div>
            );
          })}
        </Card>
      )}

      <Card>
        <CardTitle action={<Button variant="ghost" size="sm" onClick={() => onNavigate('/transactions')}>Все</Button>}>
          Последние операции
        </CardTitle>
        <TransactionList
          items={recent}
          onSelect={onSelect}
          emptyState={
            <EmptyState icon="list" title="Операций за этот месяц нет"
                        action={<Button variant="primary" icon="plus" onClick={onAdd}>Добавить</Button>} />
          }
        />
      </Card>
    </div>
  );
}
