import { useMemo } from 'react';
import { countOf, formatMoney, plural } from '@checkbudget/shared';
import type { Transaction } from '@checkbudget/shared';
import { useApp, useLookups } from '../data/hooks.js';
import { Card, CardTitle, EmptyState, Button, ProgressBar, Skeleton } from '../components/ui.js';
import { RankedBars, StackedMonths, type Slice } from '../components/charts.js';
import { TransactionList } from '../components/TransactionList.js';
import { AnimatedNumber } from '../components/AnimatedNumber.js';
import { Icon } from '../components/Icon.js';
import { periodBounds, formatPeriod, lastMonths, shortMonth } from '../lib/dates.js';

/** Три крупнейшие статьи получают цветную плитку — дальше цвет перестаёт различать. */
const BLOCKS = 3;

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

    // По каждой корневой статье собираем не только сумму: плитка обещает
    // рассказать, ИЗ ЧЕГО статья состоит, а для этого нужны подкатегории
    // и число операций.
    const roots = new Map<string, { value: number; count: number; children: Map<string, number> }>();

    for (const tx of data.transactions) {
      if (tx.occurredOn < from || tx.occurredOn > to || tx.type === 'transfer') continue;
      if (tx.baseAmountMinor === null) { unconverted++; continue; }
      if (tx.type === 'income') { income += tx.baseAmountMinor; continue; }
      expense += tx.baseAmountMinor;

      const category = tx.categoryId ? categoryById.get(tx.categoryId) : null;
      const rootId = category?.parentId ?? category?.id;
      if (!rootId) continue;

      const entry = roots.get(rootId) ?? { value: 0, count: 0, children: new Map<string, number>() };
      entry.value += tx.baseAmountMinor;
      entry.count += 1;
      if (category && category.parentId) {
        entry.children.set(category.name, (entry.children.get(category.name) ?? 0) + tx.baseAmountMinor);
      }
      roots.set(rootId, entry);
    }

    // Баланс — сумма всех счетов, приведённая к базовой валюте.
    // Счета в других валютах показываются отдельно на экране «Счета»:
    // складывать их без курса на сегодня было бы неверно.
    const balance = data.accounts
      .filter((a) => !a.isArchived && a.currency === base)
      .reduce((sum, a) => sum + a.balanceMinor, 0);
    const otherCurrencies = data.accounts.filter((a) => !a.isArchived && a.currency !== base).length;

    const slices: Array<Slice & { count: number; detail: string }> = [...roots.entries()]
      .map(([id, entry]) => {
        const category = categoryById.get(id);
        const top = [...entry.children.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
        const detail = top.length >= 2
          ? top.map(([name, value]) => `${name.toLowerCase()} ${formatMoney(value, base)}`).join(' · ')
          : `${entry.count} ${plural(entry.count, ['операция', 'операции', 'операций'])}`
            + ` · в среднем ${formatMoney(Math.round(entry.value / Math.max(entry.count, 1)), base)}`;
        return {
          id, value: entry.value, count: entry.count, detail,
          label: category?.name ?? 'Прочее',
          color: category?.color ?? 'var(--cat-stone)',
        };
      })
      .sort((a, b) => b.value - a.value);

    const top = slices.slice(0, 5);
    const rest = slices.slice(5);
    if (rest.length > 0) {
      top.push({
        id: 'rest', label: 'Остальное', color: 'var(--cat-stone)', count: 0, detail: '',
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

    return {
      income, expense, balance, unconverted, otherCurrencies, base,
      blocks: slices.slice(0, BLOCKS), ranked: top, months,
      statCount: slices.length,
    };
  }, [data, period, categoryById]);

  const recent = useMemo(() => {
    if (!data) return [];
    const { from, to } = periodBounds(period);
    return data.transactions.filter((t) => t.occurredOn >= from && t.occurredOn <= to).slice(0, 6);
  }, [data, period]);

  const limits = useMemo(
    () => (data?.limits ?? []).filter((l) => l.period === period).slice(0, 4),
    [data?.limits, period],
  );

  if (!data || !stats) {
    return (
      <div className="stack">
        <Card className="card--pad"><Skeleton height={120} /></Card>
        <Card className="card--pad"><Skeleton height={200} /></Card>
      </div>
    );
  }

  const base = stats.base;
  const budgeted = (data.limits ?? []).filter((l) => l.period === period)
    .reduce((sum, l) => sum + l.limitMinor, 0);
  const spentOnBudgeted = (data.limits ?? []).filter((l) => l.period === period)
    .reduce((sum, l) => sum + l.spentMinor, 0);
  const monthLabel = formatPeriod(period).toLowerCase();

  return (
    <div className="stack">
      <div className="grid-2 grid-2--wide">
        <section className="hero">
          <p className="hero__label">
            Итого на счетах · {monthLabel}{stats.otherCurrencies > 0 ? ` · ${base}` : ''}
          </p>
          {/* Числа переходят, а не подменяются: изменение может прийти
              с другого устройства, и мгновенная подмена не оставила бы следа. */}
          <p className="hero__value">
            <AnimatedNumber value={stats.balance} currency={base} />
          </p>
          {/* Во врезках копейки не показываются: три суммы в ряд с копейками
              не помещаются даже на широком экране, а обрезанное многоточием
              число хуже округлённого. Точное значение остаётся в подсказке
              и целиком видно на экране аналитики. */}
          <div className="hero__split">
            <div className="hero__item" title={formatMoney(stats.income, base)}>
              <span>Пришло</span>
              <strong>
                <AnimatedNumber value={stats.income} currency={base} showFraction="never" />
              </strong>
            </div>
            <div className="hero__item" title={formatMoney(stats.expense, base)}>
              <span>Ушло</span>
              <strong>
                <AnimatedNumber value={stats.expense} currency={base} showFraction="never" />
              </strong>
            </div>
            {/* Светлая врезка — то число, ради которого на блок и смотрят. */}
            <div className="hero__item hero__item--out" title={formatMoney(stats.income - stats.expense, base)}>
              <span>Осталось</span>
              <strong>
                <AnimatedNumber value={stats.income - stats.expense} currency={base} showFraction="never" />
              </strong>
            </div>
          </div>
        </section>

        <Card className="card--pad">
          <header className="card__head">
            <h2 className="card__title">Полгода</h2>
            <div style={{ flex: 1 }} />
            <span className="card__note">доход минус расход — это отложено</span>
          </header>
          <StackedMonths points={stats.months} />
        </Card>
      </div>

      {stats.unconverted > 0 && (
        <div className="banner banner--offline">
          <Icon name="warning" size={16} />
          {countOf(stats.unconverted, ['операция', 'операции', 'операций'])} без курса — не учтены в итогах
        </div>
      )}

      {stats.blocks.length > 0 && (
        <section>
          <header className="card__head" style={{ padding: '0 var(--s2)' }}>
            <h2 className="card__title">На что ушли {formatMoney(stats.expense, base)}</h2>
            <span className="card__note">
              {countOf(stats.statCount, ['статья', 'статьи', 'статей'])} · {monthLabel}
            </span>
            <div style={{ flex: 1 }} />
            <Button variant="link" onClick={() => onNavigate('/transactions')}>Разобрать по дням</Button>
          </header>

          <div className="grid-3">
            {stats.blocks.map((slice) => (
              <button
                key={slice.id}
                className="catblock"
                style={{ ['--cat' as string]: slice.color }}
                onClick={() => onNavigate('/analytics')}
              >
                <span className="catblock__top">
                  <span className="catblock__name">{slice.label}</span>
                  <span className="catblock__share">
                    {Math.round((slice.value / (stats.expense || 1)) * 100)}%
                  </span>
                </span>
                <p className="catblock__value">{formatMoney(slice.value, base)}</p>
                <p className="catblock__sub">{slice.detail}</p>
              </button>
            ))}
          </div>

          <Card className="card--pad" style={{ marginTop: 'var(--s3)' }}>
            <header className="card__head">
              <h2 className="card__title" style={{ fontSize: 'var(--t-lead)' }}>Все статьи по величине</h2>
              <span className="card__note">
                полосы в одном масштабе — видно, во сколько раз одно больше другого
              </span>
            </header>
            <RankedBars slices={stats.ranked} currency={base} total={stats.expense} />
          </Card>
        </section>
      )}

      <div className="grid-2">
        {budgeted > 0 && (
          <Card className="card--pad">
            <header className="card__head">
              <h2 className="card__title">Лимиты</h2>
              <div style={{ flex: 1 }} />
              <Button variant="link" onClick={() => onNavigate('/budgets')}>Все лимиты</Button>
            </header>

            {limits.map((limit) => {
              const category = categoryById.get(limit.categoryId);
              const pct = limit.limitMinor > 0 ? (limit.spentMinor / limit.limitMinor) * 100 : 0;
              const over = limit.spentMinor > limit.limitMinor;
              const left = limit.limitMinor - limit.spentMinor;
              return (
                <div className="limit" key={limit.id}>
                  <div className="limit__top">
                    <span className="limit__name">{category?.name ?? 'Категория'}</span>
                    <div style={{ flex: 1 }} />
                    {/* При превышении меняется и слово, и знак: «осталось −640»
                        было бы не ошибкой в счёте, а ошибкой в языке. */}
                    <span className={`money ${over ? 'tone-expense' : 'tone-muted'}`}
                          style={{ fontSize: 'var(--t-small)' }}>
                      {over ? `−${formatMoney(-left, base)}` : formatMoney(left, base)}
                    </span>
                  </div>
                  <ProgressBar
                    value={pct}
                    tone={over ? 'over' : pct > 80 ? 'warn' : 'ok'}
                    color={over || pct > 80 ? undefined : category?.color}
                  />
                </div>
              );
            })}

            <p className="card__note" style={{ display: 'block', marginTop: 'var(--s4)' }}>
              Из {formatMoney(budgeted, base)} потрачено {formatMoney(spentOnBudgeted, base)}.
            </p>
          </Card>
        )}

        <Card className="card--pad">
          <header className="card__head">
            <h2 className="card__title">Последние операции</h2>
            <div style={{ flex: 1 }} />
            <Button variant="link" onClick={() => onNavigate('/transactions')}>Все операции</Button>
          </header>
          <TransactionList
            items={recent}
            onSelect={onSelect}
            compact
            emptyState={
              <EmptyState icon="list" title="Операций за этот месяц нет"
                          action={<Button variant="primary" icon="plus" onClick={onAdd}>Добавить</Button>} />
            }
          />
        </Card>
      </div>

      {data.goals.length > 0 && (
        <Card className="card--pad">
          <CardTitle>Цели</CardTitle>
          {data.goals.map((goal) => {
            const pct = goal.targetMinor > 0 ? (goal.savedMinor / goal.targetMinor) * 100 : 0;
            return (
              <div className="limit" key={goal.id}>
                <div className="limit__top">
                  <Icon name={goal.icon} size={17} />
                  <span className="limit__name">{goal.name}</span>
                  <div style={{ flex: 1 }} />
                  <span className="tnum tone-muted" style={{ fontSize: 'var(--t-small)' }}>{Math.round(pct)}%</span>
                </div>
                <ProgressBar value={pct} tone="goal" />
                <div className="limit__nums">
                  <span>{formatMoney(goal.savedMinor, goal.currency)}</span>
                  <span>из {formatMoney(goal.targetMinor, goal.currency)}</span>
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
