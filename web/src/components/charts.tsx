import { useEffect, useId, useState } from 'react';
import { formatMoney } from '@checkbudget/shared';

/**
 * Появление графика.
 *
 * Возвращает 0 на первом кадре и 1 после — за счёт этого CSS-переход
 * отрабатывает от нуля, и график «вырастает» вместо мгновенного появления.
 * Отрисовка данных здесь не задерживается: сразу видно и структуру,
 * и подписи, анимируется только геометрия.
 *
 * При включённом «уменьшить движение» возвращает 1 сразу.
 */
function useEntrance(): number {
  const [progress, setProgress] = useState(
    () => (typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 0),
  );

  useEffect(() => {
    if (progress === 1) return;

    // Таймер рядом с кадром — не перестраховка. В фоновой вкладке
    // requestAnimationFrame не вызывается вообще, и график, смонтированный
    // там, остался бы пустым: не «неанимированным», а именно пустым,
    // потому что от прогресса зависит сама геометрия.
    const frame = requestAnimationFrame(() => setProgress(1));
    const fallback = setTimeout(() => setProgress(1), 60);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(fallback);
    };
  }, [progress]);

  return progress;
}

/**
 * Графики нарисованы вручную: SVG для кривой, обычная разметка для полос.
 *
 * Причина не в экономии килобайт, а в контроле: все они подчиняются одной
 * цветовой системе и должны работать в тёмной теме, где цвет категории
 * подмешивается с белым прямо в CSS.
 */

export interface Slice {
  id: string;
  label: string;
  value: number;
  color: string;
}

/**
 * Расходы по статьям — горизонтальные полосы в одном масштабе.
 *
 * Пришли на место кольца. Кольцо показывает доли, но не показывает, ВО
 * СКОЛЬКО РАЗ одна статья больше другой, — а именно этот вопрос задают,
 * глядя на структуру расходов. Долю при этом никто не потерял: она
 * написана числом справа.
 */
export function RankedBars({
  slices, currency, total, limit,
}: { slices: Slice[]; currency: string; total: number; limit?: number }) {
  const entrance = useEntrance();
  const max = Math.max(1, ...slices.map((s) => s.value));
  const sum = total || slices.reduce((acc, s) => acc + s.value, 0) || 1;
  const rows = limit ? slices.slice(0, limit) : slices;

  return (
    <div className="rank">
      {rows.map((slice) => (
        <div className="rank__row" key={slice.id}>
          <span className="rank__name">{slice.label}</span>
          <span className="rank__track">
            <span
              className="rank__fill"
              style={{
                ['--cat' as string]: slice.color,
                width: `${(slice.value / max) * 100 * entrance}%`,
              }}
            />
          </span>
          <span className="rank__value">{formatMoney(slice.value, currency)}</span>
          <span className="rank__share">{Math.round((slice.value / sum) * 100)}%</span>
        </div>
      ))}
    </div>
  );
}

export interface BarPoint {
  label: string;
  income: number;
  expense: number;
}

/**
 * Месяцы одной колонкой: доход сверху, расход снизу.
 *
 * Раздельные столбцы отвечали на вопрос «что больше», сложенные отвечают
 * на другой, более нужный: сколько от дохода осталось. Текущий месяц
 * выделен насыщенной заливкой — он ещё не закончился, и сравнивать его
 * с завершёнными надо с поправкой.
 */
export function StackedMonths({
  points, height = 150,
}: { points: BarPoint[]; height?: number }) {
  const entrance = useEntrance();
  const max = Math.max(1, ...points.map((p) => Math.max(p.income, p.expense, 1)));
  const last = points.length - 1;

  return (
    <div>
      <div className="stack-bars" style={{ height }}>
        {points.map((point, index) => {
          const saved = Math.max(0, point.income - point.expense);
          return (
            <div key={point.label} className={`stack-bars__col ${index === last ? 'is-current' : ''}`}>
              <span
                className="stack-bars__part stack-bars__part--income"
                style={{ height: `${(saved / max) * 100 * entrance}%` }}
              />
              <span
                className="stack-bars__part stack-bars__part--expense"
                style={{ height: `${(point.expense / max) * 100 * entrance}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="stack-bars__axis">
        {points.map((point, index) => (
          <span key={point.label} className={index === last ? 'is-current' : ''}>{point.label}</span>
        ))}
      </div>
      <div className="chart-legend">
        <span><i style={{ background: 'var(--cat-sage)' }} />отложено</span>
        <span><i style={{ background: 'var(--accent)' }} />потрачено</span>
      </div>
    </div>
  );
}

export function AreaLine({
  values, labels, currency, height = 190, color = 'var(--accent)', pace, paceLabel,
}: {
  values: number[]; labels: string[]; currency: string;
  height?: number; color?: string;
  /** Итог для равномерного темпа — по нему рисуется опорная прямая. */
  pace?: number;
  paceLabel?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const entrance = useEntrance();
  // Идентификаторы градиентов уникальны на страницу: два графика с одним
  // id ссылались бы на одну заливку, и второй перекрасился бы в цвет первого.
  const uid = useId().replace(/:/g, '');
  if (values.length === 0) return null;

  const width = 600;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, pace ?? 1, 1);
  const span = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : width;
  const yOf = (value: number) => height - ((value - min) / span) * (height - 26) - 13;

  const points = values.map((value, i) => ({ x: i * stepX, y: yOf(value) }));

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const focused = active !== null ? points[active] : null;

  return (
    <div className="area">
      <svg
        viewBox={`0 0 ${width} ${height}`} height={height} width="100%" preserveAspectRatio="none"
        role="img" aria-label="Накопительный расход за месяц"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = (e.clientX - rect.left) / rect.width;
          setActive(Math.max(0, Math.min(values.length - 1, Math.round(ratio * (values.length - 1)))));
        }}
        onMouseLeave={() => setActive(null)}
      >
        <defs>
          {/* Три остановки, а не две: линейное затухание даёт ровный клин,
              из-за которого заливка выглядит плёнкой. */}
          <linearGradient id={`fill-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.30" />
            <stop offset="46%" stopColor={color} stopOpacity="0.10" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Опорная прямая равномерного темпа: без неё накопительная кривая
            растёт всегда и сама по себе ни о чём не сообщает. */}
        {pace !== undefined && pace > 0 && (
          <line
            x1="0" y1={yOf(0)} x2={width} y2={yOf(pace)}
            className="area__pace"
            strokeDasharray="5 6" vectorEffect="non-scaling-stroke"
            style={{ opacity: entrance, transition: 'opacity var(--dur-slow) var(--ease-soft) 320ms' }}
          />
        )}

        <path
          d={area} fill={`url(#fill-${uid})`}
          style={{ opacity: entrance, transition: 'opacity var(--dur-slow) var(--ease-soft) 260ms' }}
        />

        {/* Тень кривой — смещённая вниз размытая копия её самой: без неё
            линия и заливка лежат в одной плоскости. */}
        <path
          className="area__cast"
          d={line} fill="none" stroke={color} strokeWidth="6"
          transform="translate(0 7)"
          strokeLinejoin="round" strokeLinecap="round"
          pathLength={1} strokeDasharray={1} strokeDashoffset={1 - entrance}
          style={{ transition: 'stroke-dashoffset var(--dur-chart) var(--ease)' }}
        />

        <path
          d={line} fill="none" stroke={color} strokeWidth="2.5"
          vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round"
          pathLength={1} strokeDasharray={1} strokeDashoffset={1 - entrance}
          style={{ transition: 'stroke-dashoffset var(--dur-chart) var(--ease)' }}
        />

        {focused && (
          <>
            <line x1={focused.x} y1="0" x2={focused.x} y2={height} className="area__cursor"
                  vectorEffect="non-scaling-stroke" />
            <circle cx={focused.x} cy={focused.y} r="6" className="area__dot-halo" fill={color} />
            <circle cx={focused.x} cy={focused.y} r="4.5" fill="var(--surface)" stroke={color} strokeWidth="2.5"
                    vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>

      {/* Подпись — плашка, а не текст поверх графика: на заливке она
          сливалась с ней, а в тёмной теме исчезала совсем. */}
      {active !== null && (
        <div className="area__tip">
          <strong>{labels[active]}</strong>
          <span className="money">{formatMoney(values[active] ?? 0, currency)}</span>
        </div>
      )}

      <div className="area__axis">
        <span>{labels[0]}</span>
        <span>{labels[labels.length - 1]} · {formatMoney(values[values.length - 1] ?? 0, currency)}</span>
      </div>

      {pace !== undefined && pace > 0 && paceLabel && (
        <p className="area__legend"><span className="area__legend-dash" />{paceLabel}</p>
      )}
    </div>
  );
}
