import { useEffect, useId, useState } from 'react';
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

/**
 * Кольцо расходов красится цветами категорий.
 *
 * Раньше здесь была ранговая шкала — от неё отказались вместе со всем
 * прежним направлением. Радуги при этом не выходит, потому что палитра
 * категорий закрытая: двенадцать тонов одной светлоты, выровненных между
 * собой. Взамен появилось главное: одна категория всегда одного цвета —
 * и в кольце, и в легенде, и в иконке в списке операций.
 */

export function Donut({
  slices, currency, total, size = 200, thickness = 26,
}: { slices: Slice[]; currency: string; total: number; size?: number; thickness?: number }) {
  const [active, setActive] = useState<string | null>(null);
  const entrance = useEntrance();
  const uid = useId().replace(/:/g, '');

  // Поле вокруг кольца. Радиус нельзя считать «впритык» к краю: при наведении
  // дуга становится толще, ложе и без того шире кольца, а сверху лежит тень —
  // всё это рисуется НАРУЖУ от радиуса и обрезалось краем SVG.
  const pad = 11;
  const radius = (size - thickness) / 2 - pad;
  const circumference = 2 * Math.PI * radius;
  const sum = slices.reduce((acc, s) => acc + s.value, 0) || 1;

  // Между секторами оставлен зазор: с круглыми торцами без него соседние
  // сектора наезжают друг на друга и граница читается как третий цвет.
  const gap = slices.length > 1 ? 5 : 0;

  let offset = 0;
  const arcs = slices.map((slice) => {
    const fraction = slice.value / sum;
    const arc = {
      ...slice,
      dash: Math.max(0, fraction * circumference - gap),
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
        <defs>
          {/* Подсветка тора: свет сверху слева, затенение снизу справа.
              Кольцо перестаёт быть плоской дугой и получает объём. */}
          <linearGradient id={`ring-${uid}`} x1="0.15" y1="0" x2="0.85" y2="1">
            <stop offset="0%" stopColor="var(--ring-hi)" />
            <stop offset="46%" stopColor="transparent" />
            <stop offset="100%" stopColor="var(--ring-lo)" />
          </linearGradient>
        </defs>

        {/* Ложе под кольцом: чуть шире и утоплено. Даёт кольцу опору,
            иначе оно висит в пустоте карточки. */}
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" className="donut__bed" strokeWidth={thickness + 5}
        />

        <g transform={`rotate(-90 ${size / 2} ${size / 2})`} className="donut__ring">
          {arcs.map((arc, index) => (
            <circle
              key={arc.id}
              cx={size / 2} cy={size / 2} r={radius}
              className="donut__arc"
              fill="none"
              strokeLinecap="round"
              strokeWidth={active === arc.id ? thickness + 4 : thickness}
              strokeDasharray={`${arc.dash * entrance} ${circumference - arc.dash * entrance}`}
              strokeDashoffset={arc.offset}
              /* Остальные сектора приглушаются, но не растворяются: на 0,35
                 кольцо целиком выглядело выцветшим, а не «один выделен». */
              opacity={active && active !== arc.id ? 0.55 : 1}
              onMouseEnter={() => setActive(arc.id)}
              onMouseLeave={() => setActive(null)}
              style={{
                ['--cat' as string]: arc.color,
                cursor: 'pointer',
                transition: 'opacity var(--dur-fast) var(--ease-soft),'
                  + ' stroke-width var(--dur-fast) var(--ease-soft),'
                  + ` stroke-dasharray var(--dur-chart) var(--ease) ${index * 70}ms`,
              }}
            />
          ))}
        </g>

        {/* Накладка со светом рисуется поверх всех секторов и не ловит курсор:
            иначе она перехватывала бы наведение у самого кольца. */}
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke={`url(#ring-${uid})`} strokeWidth={thickness}
          pointerEvents="none"
        />

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

export function Legend({ slices, currency }: { slices: Slice[]; currency: string; total?: number }) {
  return (
    <ul className="legend">
      {slices.map((slice) => (
        <li key={slice.id} className="legend__row">
          <span className="legend__swatch" style={{ ['--cat' as string]: slice.color }} />
          <span className="legend__label">{slice.label}</span>
          {/* Процента здесь нет намеренно: долю показывает само кольцо,
              и рядом с ним колонка процентов дублирует картинку, а строку
              делает из двух колонок трёхколонной. Число отвечает на другой
              вопрос — сколько это в деньгах. */}
          <span className="legend__value money">{formatMoney(slice.value, currency)}</span>
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
  points, currency, height = 220,
}: { points: BarPoint[]; currency: string; height?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const entrance = useEntrance();
  const max = Math.max(1, ...points.map((p) => Math.max(p.income, p.expense)));
  const barWidth = 100 / Math.max(points.length, 1);

  return (
    <div className="bars">
      <div className="bars__plot" style={{ height }}>
        {/* Нулевая линия — ось, от которой отсчитываются столбцы.
            Опорные линии выше неё были бы сеткой поверх сетки страницы,
            а вот основание нужно: без него столбцы висят в пустоте. */}
        <div className="bars__base" />
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
              из-за которого заливка выглядит плёнкой. Плотное начало
              и быстрый спад дают ей толщину. */}
          <linearGradient id={`fill-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.34" />
            <stop offset="46%" stopColor={color} stopOpacity="0.12" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Опорная прямая равномерного темпа: без неё кривая не отвечает
            на вопрос, ради которого её смотрят, — «иду я быстрее или медленнее».
            Заодно график перестаёт быть одной линией в пустом прямоугольнике. */}
        {pace !== undefined && pace > 0 && (
          <line
            x1="0" y1={yOf(0)} x2={width} y2={yOf(pace)}
            className="area__pace"
            strokeDasharray="5 6" vectorEffect="non-scaling-stroke"
            style={{ opacity: entrance, transition: 'opacity var(--dur-slow) var(--ease-soft) 320ms' }}
          />
        )}

        <path
          d={area}
          fill={`url(#fill-${uid})`}
          style={{
            opacity: entrance,
            transition: 'opacity var(--dur-slow) var(--ease-soft) 260ms',
          }}
        />

        {/* Тень кривой — смещённая вниз копия её самой. Она поднимает линию
            над заливкой: без неё линия и заливка лежат в одной плоскости
            и график выглядит наклейкой. */}
        <path
          className="area__cast"
          d={line} fill="none" stroke={color} strokeWidth="6"
          transform="translate(0 7)"
          strokeLinejoin="round" strokeLinecap="round"
          pathLength={1} strokeDasharray={1} strokeDashoffset={1 - entrance}
          style={{ transition: 'stroke-dashoffset var(--dur-chart) var(--ease)' }}
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
            <line x1={focused.x} y1="0" x2={focused.x} y2={height} className="area__cursor"
                  vectorEffect="non-scaling-stroke" />
            <circle cx={focused.x} cy={focused.y} r="6" className="area__dot-halo" fill={color} />
            <circle cx={focused.x} cy={focused.y} r="4.5" fill="var(--surface)" stroke={color} strokeWidth="2.5"
                    vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>

      {/* Подпись — плашка, а не текст поверх графика. Раньше она лежала прямо
          на заливке и на светлом конце сливалась с ней; на тёмной теме
          пропадала совсем. */}
      {active !== null && (
        <div className="area__tip">
          <strong>{labels[active]}</strong>
          <span className="money">{formatMoney(values[active] ?? 0, currency)}</span>
        </div>
      )}
      {pace !== undefined && pace > 0 && paceLabel && (
        <p className="area__legend"><span className="area__legend-dash" />{paceLabel}</p>
      )}
    </div>
  );
}
