import { useEffect, useState } from 'react';
import { formatCompact, formatMoney } from '@checkbudget/shared';

/**
 * Появление графика.
 *
 * Возвращает 0 на первом кадре и 1 после — за счёт этого CSS-переход
 * отрабатывает от нуля, и график «вырастает» вместо мгновенного появления.
 * Отрисовка данных здесь не задерживается: сразу видно и структуру, и подписи,
 * анимируется только геометрия.
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
 * Графики нарисованы вручную на SVG.
 *
 * Причина не в экономии килобайт, а в контроле: в приложении три типа
 * графиков, все они подчиняются одной цветовой системе (расход / доход /
 * категория) и должны корректно работать в тёмной теме. Библиотека общего
 * назначения здесь дала бы больше настройки, чем собственный код.
 */

export interface Slice {
  id: string;
  label: string;
  value: number;
  color: string;
}

export function Donut({
  slices, currency, total, size = 180, thickness = 22,
}: { slices: Slice[]; currency: string; total: number; size?: number; thickness?: number }) {
  const [active, setActive] = useState<string | null>(null);
  const entrance = useEntrance();
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const sum = slices.reduce((acc, s) => acc + s.value, 0) || 1;

  let offset = 0;
  const arcs = slices.map((slice) => {
    const fraction = slice.value / sum;
    const arc = {
      ...slice,
      dash: fraction * circumference,
      gap: circumference - fraction * circumference,
      offset: -offset * circumference,
      percent: Math.round(fraction * 100),
    };
    offset += fraction;
    return arc;
  });

  const focused = arcs.find((a) => a.id === active);

  return (
    <div className="donut">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
           aria-label="Структура расходов по категориям">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {arcs.map((arc, index) => (
            <circle
              key={arc.id}
              cx={size / 2} cy={size / 2} r={radius}
              fill="none"
              stroke={arc.color}
              strokeWidth={active === arc.id ? thickness + 4 : thickness}
              strokeDasharray={`${arc.dash * entrance} ${circumference - arc.dash * entrance}`}
              strokeDashoffset={arc.offset}
              opacity={active && active !== arc.id ? 0.35 : 1}
              onMouseEnter={() => setActive(arc.id)}
              onMouseLeave={() => setActive(null)}
              style={{
                cursor: 'pointer',
                transition: 'opacity var(--dur-fast) var(--ease-soft),'
                  + ' stroke-width var(--dur-fast) var(--ease-soft),'
                  + ` stroke-dasharray var(--dur-chart) var(--ease) ${index * 70}ms`,
              }}
            />
          ))}
        </g>
        <text x="50%" y="46%" textAnchor="middle" className="donut__value tnum">
          {formatCompact(focused ? focused.value : total, currency)}
        </text>
        <text x="50%" y="60%" textAnchor="middle" className="donut__label">
          {focused ? `${focused.label} · ${focused.percent}%` : 'всего'}
        </text>
      </svg>
    </div>
  );
}

export function Legend({ slices, currency, total }: { slices: Slice[]; currency: string; total: number }) {
  return (
    <ul className="legend">
      {slices.map((slice) => (
        <li key={slice.id} className="legend__row">
          <span className="legend__swatch" style={{ background: slice.color }} />
          <span className="legend__label">{slice.label}</span>
          <span className="legend__pct tnum">
            {total > 0 ? Math.round((slice.value / total) * 100) : 0}%
          </span>
          <span className="legend__value tnum">{formatMoney(slice.value, currency)}</span>
        </li>
      ))}
    </ul>
  );
}

export interface BarPoint {
  label: string;
  income: number;
  expense: number;
}

export function GroupedBars({
  points, currency, height = 180,
}: { points: BarPoint[]; currency: string; height?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const entrance = useEntrance();
  const max = Math.max(1, ...points.map((p) => Math.max(p.income, p.expense)));
  const barWidth = 100 / Math.max(points.length, 1);

  return (
    <div className="bars">
      <div className="bars__plot" style={{ height }}>
        {/* Опорные линии дают глазу шкалу без подписей осей —
            точные значения всё равно читаются в подсказке. */}
        {[0.25, 0.5, 0.75, 1].map((r) => (
          <div key={r} className="bars__grid" style={{ bottom: `${r * 100}%` }} />
        ))}
        {points.map((point, index) => (
          <div
            key={point.label}
            className={`bars__group ${active === index ? 'is-active' : ''}`}
            style={{ width: `${barWidth}%` }}
            onMouseEnter={() => setActive(index)}
            onMouseLeave={() => setActive(null)}
          >
            <div className="bars__pair">
              {/* Задержка по столбцам делает движение направленным слева
                  направо — то есть по ходу времени, а не хаотичным. */}
              <div
                className="bars__bar bars__bar--income"
                style={{
                  height: `${(point.income / max) * 100 * entrance}%`,
                  transitionDelay: `${index * 55}ms`,
                }}
              />
              <div
                className="bars__bar bars__bar--expense"
                style={{
                  height: `${(point.expense / max) * 100 * entrance}%`,
                  transitionDelay: `${index * 55 + 25}ms`,
                }}
              />
            </div>
            {active === index && (
              <div className="bars__tip">
                <strong>{point.label}</strong>
                <span className="tone-income tnum">+{formatMoney(point.income, currency)}</span>
                <span className="tone-expense tnum">−{formatMoney(point.expense, currency)}</span>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="bars__axis">
        {points.map((point) => (
          <span key={point.label} style={{ width: `${barWidth}%` }}>{point.label}</span>
        ))}
      </div>
    </div>
  );
}

export function AreaLine({
  values, labels, currency, height = 160, color = 'var(--accent)',
}: { values: number[]; labels: string[]; currency: string; height?: number; color?: string }) {
  const [active, setActive] = useState<number | null>(null);
  const entrance = useEntrance();
  if (values.length === 0) return null;

  const width = 600;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const span = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : width;

  const points = values.map((value, i) => ({
    x: i * stepX,
    y: height - ((value - min) / span) * (height - 20) - 10,
  }));

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const focused = active !== null ? points[active] : null;

  return (
    <div className="area">
      <svg
        viewBox={`0 0 ${width} ${height}`} height={height} width="100%" preserveAspectRatio="none"
        role="img" aria-label="Динамика баланса"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = (e.clientX - rect.left) / rect.width;
          setActive(Math.max(0, Math.min(values.length - 1, Math.round(ratio * (values.length - 1)))));
        }}
        onMouseLeave={() => setActive(null)}
      >
        <defs>
          <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d={area}
          fill="url(#areaFill)"
          style={{
            opacity: entrance,
            transition: 'opacity var(--dur-slow) var(--ease-soft) 260ms',
          }}
        />
        {/* Линия прочерчивается слева направо: пунктиром во всю длину,
            у которого смещение уезжает от полной длины к нулю. */}
        <path
          d={line} fill="none" stroke={color} strokeWidth="2.5"
          vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - entrance}
          style={{ transition: 'stroke-dashoffset var(--dur-chart) var(--ease)' }}
        />
        {focused && (
          <>
            <line x1={focused.x} y1="0" x2={focused.x} y2={height} stroke="var(--border-strong)" strokeWidth="1"
                  vectorEffect="non-scaling-stroke" />
            <circle cx={focused.x} cy={focused.y} r="4.5" fill="var(--surface)" stroke={color} strokeWidth="2.5"
                    vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>
      {active !== null && (
        <div className="area__tip">
          <strong>{labels[active]}</strong>
          <span className="tnum">{formatMoney(values[active] ?? 0, currency)}</span>
        </div>
      )}
    </div>
  );
}
