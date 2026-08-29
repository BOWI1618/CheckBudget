import { useMemo, useState } from 'react';
import { formatMoney } from '@checkbudget/shared';
import { useApp, useLookups } from '../data/hooks.js';
import { Card, CardTitle, EmptyState, Segmented } from '../components/ui.js';
import { Donut, Legend, GroupedBars, AreaLine, type Slice } from '../components/charts.js';
import { CategoryDot } from '../components/ui.js';
import { periodBounds, formatPeriod, lastMonths, shortMonth, shiftPeriod, formatShortDate } from '../lib/dates.js';

type Kind = 'expense' | 'income';

export function AnalyticsScreen({ period }: { period: string }) {
  const app = useApp();
  const data = app.data;
  const { categoryById } = useLookups();
  const [kind, setKind] = useState<Kind>('expense');

  const base = data?.budget.baseCurrency ?? 'RUB';

  const analysis = useMemo(() => {
    if (!data) return null;
    const { from, to } = periodBounds(period);

    const inRange = (iso: string, a: string, b: string) => iso >= a && iso <= b;

    let current = 0;
    // Прошлый месяц берётся из готовых итогов: он может лежать за границей
    // загруженного окна операций, и подсчёт по сырым строкам дал бы ноль.
    const previousTotals = data.monthly.find((r) => r.month === shiftPeriod(period, -1));
    const prior = kind === 'expense'
      ? previousTotals?.expenseMinor ?? 0
      : previousTotals?.incomeMinor ?? 0;
    const byRoot = new Map<string, number>();
    const byDay = new Map<string, number>();
    const largest: Array<{ id: string; amount: number; label: string; color: string; icon: string; day: string }> = [];

    for (const tx of data.transactions) {
      if (tx.type !== kind || tx.baseAmountMinor === null) continue;
      if (!inRange(tx.occurredOn, from, to)) continue;

      current += tx.baseAmountMinor;
      byDay.set(tx.occurredOn, (byDay.get(tx.occurredOn) ?? 0) + tx.baseAmountMinor);

      const category = tx.categoryId ? categoryById.get(tx.categoryId) : null;
      const rootId = category?.parentId ?? category?.id;
      if (rootId) byRoot.set(rootId, (byRoot.get(rootId) ?? 0) + tx.baseAmountMinor);

      largest.push({
        id: tx.id, amount: tx.baseAmountMinor, day: tx.occurredOn,
        label: category?.name ?? 'Без категории',
        color: category?.color ?? '#64748b',
        icon: category?.icon ?? 'tag',
      });
    }

    const slices: Slice[] = [...byRoot.entries()]
      .map(([id, value]) => {
        const category = categoryById.get(id);
        return { id, value, label: category?.name ?? 'Прочее', color: category?.color ?? '#64748b' };
      })
      .sort((a, b) => b.value - a.value);

    // Накопительная кривая за месяц отвечает на вопрос «укладываюсь ли я
    // в темп», на который обычный столбчатый график не отвечает.
    const days: string[] = [];
    const cumulative: number[] = [];
    let running = 0;
    const lastDay = Number(to.slice(8, 10));
    for (let d = 1; d <= lastDay; d++) {
      const iso = `${period}-${String(d).padStart(2, '0')}`;
      running += byDay.get(iso) ?? 0;
      days.push(formatShortDate(iso));
      cumulative.push(running);
    }

    const totals = new Map(data.monthly.map((r) => [r.month, r]));
    const months = lastMonths(6).map((m) => ({
      label: shortMonth(m),
      income: totals.get(m)?.incomeMinor ?? 0,
      expense: totals.get(m)?.expenseMinor ?? 0,
    }));

    return {
      current, prior, slices, months, days, cumulative,
      largest: largest.sort((a, b) => b.amount - a.amount).slice(0, 5),
    };
  }, [data, period, kind, categoryById]);

  if (!data || !analysis) return null;

  const delta = analysis.prior > 0
    ? Math.round(((analysis.current - analysis.prior) / analysis.prior) * 100)
    : null;

  return (
    <div className="stack">
      <Segmented<Kind>
        value={kind} onChange={setKind}
        options={[
          { value: 'expense', label: 'Расходы', tone: 'expense' },
          { value: 'income', label: 'Доходы', tone: 'income' },
        ]}
      />

      <div className="grid-2">
        <Card className="kpi">
          <span className="kpi__label">{formatPeriod(period)}</span>
          <span className={`kpi__value tnum ${kind === 'expense' ? 'tone-expense' : 'tone-income'}`}>
            {formatMoney(analysis.current, base)}
          </span>
        </Card>
        <Card className="kpi">
          <span className="kpi__label">
            Против {formatPeriod(shiftPeriod(period, -1)).toLowerCase()}
          </span>
          <span className="kpi__value tnum">
            {/* Тот же знак минуса, что и в суммах: «−», а не дефис. */}
            {delta === null ? '—' : `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${Math.abs(delta)}%`}
            <span className="tone-muted" style={{ fontSize: 13, fontWeight: 500, marginLeft: 8 }}>
              {formatMoney(analysis.prior, base)}
            </span>
          </span>
        </Card>
      </div>

      <Card>
        <CardTitle>Накопительно за месяц</CardTitle>
        {analysis.current === 0 ? (
          <EmptyState icon="chart" title="Данных за период нет" />
        ) : (
          <AreaLine
            values={analysis.cumulative} labels={analysis.days} currency={base}
            color={kind === 'expense' ? 'var(--expense)' : 'var(--income)'}
          />
        )}
      </Card>

      <div className="grid-2 grid-2--wide">
        <Card>
          <CardTitle>По категориям</CardTitle>
          {analysis.slices.length === 0 ? (
            <EmptyState icon="tag" title="Нет операций за период" />
          ) : (
            <div className="row" style={{ gap: 20, flexWrap: 'wrap' }}>
              <Donut slices={analysis.slices.slice(0, 8)} currency={base} total={analysis.current} />
              <div style={{ flex: 1, minWidth: 210 }}>
                <Legend slices={analysis.slices.slice(0, 8)} currency={base} total={analysis.current} />
              </div>
            </div>
          )}
        </Card>

        <Card>
          <CardTitle>Сравнение месяцев</CardTitle>
          <GroupedBars points={analysis.months} currency={base} />
        </Card>
      </div>

      <Card>
        <CardTitle>Самые крупные {kind === 'expense' ? 'расходы' : 'поступления'}</CardTitle>
        {analysis.largest.length === 0 ? (
          <EmptyState icon="list" title="Нет операций за период" />
        ) : (
          analysis.largest.map((item) => (
            <div className="list-row" key={item.id}>
              <CategoryDot color={item.color} icon={item.icon} size={32} />
              <div className="list-row__body">
                <div className="list-row__title">{item.label}</div>
                <div className="list-row__sub">{formatShortDate(item.day)}</div>
              </div>
              <span className="leader" aria-hidden="true" />
              <span className="money" style={{ fontWeight: 600 }}>{formatMoney(item.amount, base)}</span>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
