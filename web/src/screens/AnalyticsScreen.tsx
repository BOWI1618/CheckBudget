import { useMemo, useState } from 'react';
import { formatMoney, plural } from '@checkbudget/shared';
import { useApp, useLookups } from '../data/hooks.js';
import { Card, EmptyState, Segmented } from '../components/ui.js';
import { RankedBars, StackedMonths, AreaLine, type Slice } from '../components/charts.js';
import { CategoryDot } from '../components/ui.js';
import { periodBounds, formatPeriod, periodGen, periodPrep, lastMonths, shortMonth, shiftPeriod, formatShortDate } from '../lib/dates.js';

type Kind = 'expense' | 'income';

export function AnalyticsScreen({ period }: { period: string }) {
  const app = useApp();
  const data = app.data;
  const { categoryById, accountById } = useLookups();
  const [kind, setKind] = useState<Kind>('expense');

  const base = data?.budget.baseCurrency ?? 'RUB';

  const analysis = useMemo(() => {
    if (!data) return null;
    const { from, to } = periodBounds(period);
    const previous = shiftPeriod(period, -1);
    const prevBounds = periodBounds(previous);

    // Сравнение по статьям возможно только если прошлый месяц действительно
    // загружен. Считать по пустому окну значило бы показать «−100%» там,
    // где данных просто нет, — а это хуже, чем не показать ничего.
    const priorLoaded = data.range.from <= prevBounds.from;

    const inRange = (iso: string, a: string, b: string) => iso >= a && iso <= b;

    let current = 0;
    let count = 0;
    const previousTotals = data.monthly.find((r) => r.month === previous);
    const prior = kind === 'expense'
      ? previousTotals?.expenseMinor ?? 0
      : previousTotals?.incomeMinor ?? 0;

    const byRoot = new Map<string, number>();
    const byRootPrior = new Map<string, number>();
    const byDay = new Map<string, number>();
    const largest: Array<{
      id: string; amount: number; label: string; color: string; icon: string;
      day: string; note: string; account: string;
    }> = [];

    for (const tx of data.transactions) {
      if (tx.type !== kind || tx.baseAmountMinor === null) continue;
      const category = tx.categoryId ? categoryById.get(tx.categoryId) : null;
      const rootId = category?.parentId ?? category?.id;

      if (priorLoaded && inRange(tx.occurredOn, prevBounds.from, prevBounds.to) && rootId) {
        byRootPrior.set(rootId, (byRootPrior.get(rootId) ?? 0) + tx.baseAmountMinor);
        continue;
      }
      if (!inRange(tx.occurredOn, from, to)) continue;

      current += tx.baseAmountMinor;
      count += 1;
      byDay.set(tx.occurredOn, (byDay.get(tx.occurredOn) ?? 0) + tx.baseAmountMinor);
      if (rootId) byRoot.set(rootId, (byRoot.get(rootId) ?? 0) + tx.baseAmountMinor);

      largest.push({
        id: tx.id, amount: tx.baseAmountMinor, day: tx.occurredOn,
        label: category?.name ?? 'Без категории',
        color: category?.color ?? 'var(--cat-stone)',
        icon: category?.icon ?? 'tag',
        note: tx.note ?? '',
        account: accountById.get(tx.accountId)?.name ?? '—',
      });
    }

    const slices: Array<Slice & { delta: number | null; was: number | null; moved: number }> =
      [...byRoot.entries()]
        .map(([id, value]) => {
          const category = categoryById.get(id);
          const was = priorLoaded ? byRootPrior.get(id) ?? 0 : null;
          return {
            id, value, was,
            label: category?.name ?? 'Прочее',
            color: category?.color ?? 'var(--cat-stone)',
            delta: was ? Math.round(((value - was) / was) * 100) : null,
            moved: was === null ? 0 : value - was,
          };
        })
        .sort((a, b) => b.value - a.value);

    // Накопительная кривая за месяц отвечает на вопрос «укладываюсь ли я
    // в темп», на который столбчатый график не отвечает.
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

    // «Что изменилось» ранжируется ДЕНЬГАМИ, а не процентами.
    //
    // Проценты обманывают: +38% на статье в 500 ₽ — это 190 ₽ и ничего
    // не значит, а +5% на аренде — это 3 000 ₽ и меняет весь месяц.
    // Сортировка по проценту выносила наверх мелочь, и карточка выглядела
    // аналитикой, ничего при этом не сообщая.
    //
    // Порог тоже денежный: сдвиг меньше 2% месячного итога — шум.
    const noise = Math.max(1, Math.round(current * 0.02));
    const movers = priorLoaded
      // Объединение, а не только текущие статьи: если на чём-то перестали
      // тратить совсем, этой статьи в этом месяце нет — а это ровно то
      // изменение, ради которого карточку и читают.
      ? [...new Set([...byRoot.keys(), ...byRootPrior.keys()])]
        .map((id) => {
          const category = categoryById.get(id);
          const value = byRoot.get(id) ?? 0;
          const was = byRootPrior.get(id) ?? 0;
          return {
            id, value, was, moved: value - was,
            label: category?.name ?? 'Прочее',
            percent: was > 0 ? Math.round(((value - was) / was) * 100) : null,
          };
        })
        .filter((m) => Math.abs(m.moved) >= noise)
        .sort((a, b) => Math.abs(b.moved) - Math.abs(a.moved))
        .slice(0, 3)
      : [];


    return {
      current, prior, count, slices, months, days, cumulative, movers,
      priorLoaded, previous,
      largest: largest.sort((a, b) => b.amount - a.amount).slice(0, 5),
    };
  }, [data, period, kind, categoryById, accountById]);

  if (!data || !analysis) return null;

  const delta = analysis.prior > 0
    ? Math.round(((analysis.current - analysis.prior) / analysis.prior) * 100)
    : null;
  const monthLabel = formatPeriod(period).toLowerCase();
  const days = Math.max(1, Number(periodBounds(period).to.slice(8, 10)));

  return (
    <div className="stack">
      <div className="row">
        <Segmented<Kind>
          value={kind} onChange={setKind}
          options={[
            { value: 'expense', label: 'Расходы', tone: 'expense' },
            { value: 'income', label: 'Доходы', tone: 'income' },
          ]}
        />
      </div>

      <div className="grid-3">
        <Card className="kpi kpi--lead">
          <span className="kpi__label">
            {kind === 'expense' ? 'Расход' : 'Доход'} за {monthLabel}
          </span>
          <span className="kpi__value tnum">{formatMoney(analysis.current, base)}</span>
          <span className="kpi__sub">
            {analysis.count} {plural(analysis.count, ['операция', 'операции', 'операций'])}
            {' · '}{formatMoney(Math.round(analysis.current / days), base)} в день
          </span>
        </Card>

        <Card className="kpi">
          <span className="kpi__label">Против {periodGen(analysis.previous)}</span>
          {/* Рост расходов — плохая новость, рост доходов — хорошая, поэтому
              одно и то же «+4%» красится по-разному. Цвет здесь несёт вывод,
              которого в самом числе нет. */}
          <span className={`kpi__value tnum ${
            delta === null || delta === 0 ? ''
              : (delta > 0) === (kind === 'income') ? 'tone-income' : 'tone-expense'
          }`}>
            {delta === null ? '—' : `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${Math.abs(delta)}%`}
          </span>
          <span className="kpi__sub">
            {analysis.prior > 0
              ? `в ${periodPrep(analysis.previous)} было ${formatMoney(analysis.prior, base)}`
              : 'сравнивать не с чем'}
          </span>
        </Card>

        <Card className="kpi">
          {/* Заголовок называет сравнение целиком, поэтому пояснения под ним
              не нужно: сколько это в процентах и сколько было, говорит
              соседняя карточка. Три строки без подводки читаются быстрее,
              чем две строки с абзацем перед ними. */}
          <span className="kpi__label">Разница с прошлым месяцем</span>

          {analysis.movers.length === 0 ? (
            <span className="kpi__sub" style={{ marginTop: 6 }}>
              {analysis.priorLoaded
                ? 'Ни одна статья не сдвинулась заметно.'
                : 'Прошлый месяц ещё не загружен — пролистайте период назад стрелкой в шапке.'}
            </span>
          ) : (
            <ul className="movers">
                {analysis.movers.map((m) => {
                  const good = (m.moved > 0) === (kind === 'income');
                  return (
                    <li className="movers__row" key={m.id}>
                      <span className="movers__name">
                        {m.label}
                        {/* Процент — подпись под названием, а не третья колонка:
                            в колонку он не помещался и обрезал названия статей. */}
                        <span className="movers__pct">
                          {m.value === 0 ? 'больше не тратим'
                            : m.percent === null ? 'новая статья'
                              : `${m.percent > 0 ? '+' : '−'}${Math.abs(m.percent)}%`}
                        </span>
                      </span>
                      {/* Деньги крупно: сортировка идёт по ним, и глаз должен
                          читать в том же порядке. */}
                      <strong className={`money movers__sum ${good ? 'tone-income' : 'tone-expense'}`}>
                        {m.moved > 0 ? '+' : '−'}{formatMoney(Math.abs(m.moved), base)}
                      </strong>
                    </li>
                  );
                })}
            </ul>
          )}
        </Card>
      </div>

      <Card className="card--pad">
        <header className="card__head">
          <h2 className="card__title">Накопительно за месяц</h2>
          <span className="card__note">
            пунктир — темп {periodGen(analysis.previous)}; выше него значит тратим быстрее
          </span>
        </header>
        {analysis.current === 0 ? (
          <EmptyState icon="chart" title="Данных за период нет" />
        ) : (
          <AreaLine
            values={analysis.cumulative} labels={analysis.days} currency={base}
            color={kind === 'expense' ? 'var(--accent)' : 'var(--income)'}
            pace={analysis.prior}
            paceLabel={`Темп ${periodGen(analysis.previous)}`}
          />
        )}
      </Card>

      <div className="grid-2 grid-2--lead">
        <Card className="card--pad">
          <header className="card__head">
            <h2 className="card__title">По категориям</h2>
            <span className="card__note">полосы в одном масштабе</span>
          </header>
          {analysis.slices.length === 0 ? (
            <EmptyState icon="chart" title="Нет операций за период" />
          ) : (
            <RankedBars slices={analysis.slices} currency={base} total={analysis.current} />
          )}
        </Card>

        <Card className="card--pad">
          <header className="card__head">
            <h2 className="card__title">Полгода</h2>
          </header>
          <StackedMonths points={analysis.months} />
        </Card>
      </div>

      <Card className="card--pad">
        <header className="card__head">
          <h2 className="card__title">
            Самые крупные {kind === 'expense' ? 'расходы' : 'поступления'}
          </h2>
          <span className="card__note">
            {analysis.largest.length} {plural(analysis.largest.length, ['операция', 'операции', 'операций'])}
            {' из '}{analysis.count}
          </span>
        </header>
        {analysis.largest.length === 0 ? (
          <EmptyState icon="list" title="Нет операций за период" />
        ) : (
          <table className="txtable">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Категория</th>
                <th className="txtable__hide-sm">Комментарий</th>
                <th className="txtable__hide-sm">Счёт</th>
                <th>Сумма</th>
              </tr>
            </thead>
            <tbody>
              {analysis.largest.map((item) => (
                <tr key={item.id}>
                  <td>{formatShortDate(item.day)}</td>
                  <td>
                    <span className="txtable__name">
                      <CategoryDot color={item.color} icon={item.icon} size={28} />
                      {item.label}
                    </span>
                  </td>
                  <td className="txtable__hide-sm">{item.note || '—'}</td>
                  <td className="txtable__hide-sm">{item.account}</td>
                  <td className="txtable__amount">
                    {kind === 'expense' ? '−' : '+'}{formatMoney(item.amount, base)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
