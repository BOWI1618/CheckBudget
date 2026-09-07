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
  values, labels, currency, height = 200, color = 'var(--accent)', pace, paceLabel, elapsed,
}: {
  values: number[]; labels: string[]; currency: string;
  height?: number; color?: string;
  /** Итог для равномерного темпа — по нему рисуется опорная прямая. */
  pace?: number;
  paceLabel?: string;
  /** Сколько дней месяца уже прожито. Дальше рисовать нечего. */
  elapsed?: number;
}) {
  const [active, setActive] = useState<number | null>(null);
  const entrance = useEntrance();
  // Идентификаторы уникальны на страницу: два графика с одним id ссылались
  // бы на одну заливку, и второй перекрасился бы в цвет первого.
  const uid = useId().replace(/:/g, '');
  if (values.length === 0) return null;

  const width = 600;

  /**
   * Линия ведётся только по прожитым дням.
   *
   * Раньше она шла до конца месяца, и хвост ненаступивших дней рисовался
   * ровной полкой на уровне сегодняшнего итога. График показывал как
   * свершившийся факт то, чего ещё не было: 6 сентября кривая обещала,
   * что 30-го расход останется прежним.
   */
  const drawn = Math.max(1, Math.min(values.length, elapsed ?? values.length));
  const partial = drawn < values.length;
  const shown = values.slice(0, drawn);

  // Запас сверху и снизу. Накопительная кривая монотонна, её последняя
  // точка — всегда максимум, и без запаса она упирается в край карточки.
  const padTop = 26;
  const padBottom = 18;
  const min = Math.min(...shown, 0);
  const max = Math.max(...shown, pace ?? 0, 1) * 1.12;
  const span = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : width;
  const plot = height - padTop - padBottom;
  const yOf = (value: number) => height - padBottom - ((value - min) / span) * plot;

  const points = shown.map((value, i) => ({ x: i * stepX, y: yOf(value) }));
  const last = points[points.length - 1]!;
  const baseY = yOf(0);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  // Заливка замыкается на нулевой линии, а не на нижнем крае кадра:
  // иначе она свисает ниже собственной оси.
  const area = `${line} L${last.x.toFixed(1)},${baseY.toFixed(1)} L0,${baseY.toFixed(1)} Z`;
  const focused = active !== null ? points[active] : null;
  // Подсказка идёт за точкой, но не вылезает за карточку.
  const tipAt = focused ? Math.min(86, Math.max(14, (focused.x / width) * 100)) : 50;

  return (
    <div className="area">
      <svg
        viewBox={`0 0 ${width} ${height}`} height={height} width="100%" preserveAspectRatio="none"
        role="img" aria-label="Накопительный расход за месяц"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = (e.clientX - rect.left) / rect.width;
          // Наведение за пределы прожитого прижимается к сегодняшнему дню:
          // о будущих днях сказать нечего.
          setActive(Math.max(0, Math.min(drawn - 1, Math.round(ratio * (values.length - 1)))));
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

          {/*
            Проявление растущей шторкой, а не штриховкой по длине пути.
            Прежний приём — pathLength=1 со strokeDasharray=1 — молча
            не работал: рядом стоит vector-effect="non-scaling-stroke",
            при котором браузер считает штрихи в экранных пикселях и
            нормировку pathLength игнорирует. Кадр растянут по горизонтали,
            экранная длина не совпадает с пользовательской, и «полный»
            штрих закрывал лишь часть линии — хвост кривой не дорисовывался
            никогда, а выглядело это как обрыв данных.
          */}
          <clipPath id={`reveal-${uid}`} clipPathUnits="userSpaceOnUse">
            <rect
              x={-12} y={-12} width={width + 24} height={height + 24}
              style={{
                transformBox: 'view-box', transformOrigin: '0 0',
                transform: `scaleX(${entrance})`,
                transition: 'transform var(--dur-chart) var(--ease)',
              }}
            />
          </clipPath>
        </defs>

        {/* Ненаступившая часть месяца залита отдельным тоном. Пустое место
            само по себе читается как обрыв данных; названная пустота
            сообщает то, ради чего график и смотрят, — месяц ещё идёт. */}
        {partial && (
          <rect
            x={last.x} y={padTop - 10} width={width - last.x} height={baseY - padTop + 10}
            className="area__ahead"
            style={{ opacity: entrance, transition: 'opacity var(--dur-slow) var(--ease-soft) 200ms' }}
          />
        )}

        {/* Нулевая линия: без неё заливке не на чем стоять. */}
        <line x1="0" y1={baseY} x2={width} y2={baseY} className="area__base"
              vectorEffect="non-scaling-stroke" />

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

        <g clipPath={`url(#reveal-${uid})`}>
          <path
            d={area} fill={`url(#fill-${uid})`}
            style={{ opacity: entrance, transition: 'opacity var(--dur-slow) var(--ease-soft) 260ms' }}
          />

          {/* Тень кривой — смещённая вниз размытая копия её самой: без неё
              линия и заливка лежат в одной плоскости. Толщина не должна
              тянуться вместе с кадром, иначе тень расплывается вбок. */}
          <path
            className="area__cast"
            d={line} fill="none" stroke={color} strokeWidth="6"
            transform="translate(0 7)" vectorEffect="non-scaling-stroke"
            strokeLinejoin="round" strokeLinecap="round"
          />

          <path
            d={line} fill="none" stroke={color} strokeWidth="2.5"
            vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round"
          />
        </g>

        {/* Точка «сегодня» видна в покое, а не только при наведении:
            в скрытой вкладке анимации заморожены, и покой обязан быть
            нормальным состоянием, а не первым кадром. */}
        {active === null && (
          <circle cx={last.x} cy={last.y} r="4.5" fill="var(--surface)" stroke={color} strokeWidth="2.5"
                  vectorEffect="non-scaling-stroke"
                  style={{ opacity: entrance, transition: 'opacity var(--dur-slow) var(--ease-soft) 380ms' }} />
        )}

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

      {/* Подсказка — плашка, а не текст поверх графика: на заливке она
          сливалась с ней, а в тёмной теме исчезала совсем. Идёт за точкой:
          прибитая к правому углу, она называла день, на который никто
          не наводил. */}
      {active !== null && (
        <div className="area__tip" style={{ left: `${tipAt}%` }}>
          <strong>{labels[active]}</strong>
          <span className="money">{formatMoney(values[active] ?? 0, currency)}</span>
        </div>
      )}

      <div className="area__axis">
        <span>{labels[0]}</span>
        {/* У незавершённого месяца справа стоит его последний день, а итог
            подписан у самой точки «сегодня». Раньше сумма стояла под
            30-м числом, хотя относилась к шестому. */}
        <span className={partial ? 'is-muted' : undefined}>
          {partial
            ? labels[labels.length - 1]
            : `${labels[labels.length - 1]} · ${formatMoney(values[values.length - 1] ?? 0, currency)}`}
        </span>
      </div>

      {/* Итог подписан у самой точки «сегодня» — и только пока на график
          не навели: иначе две плашки говорили бы об одном и том же. */}
      {partial && active === null && (
        <div
          className="area__now"
          style={{
            left: `${(last.x / width) * 100}%`,
            top: `${last.y}px`,
            // Слева от точки подпись легла бы на саму кривую: она приходит
            // снизу слева. Справа от точки пусто — там подписи и место.
            // У края кадра стороны меняются местами.
            transform: last.x / width > 0.62
              ? 'translate(calc(-100% - 12px), -50%)'
              : 'translate(12px, -50%)',
            alignItems: last.x / width > 0.62 ? 'flex-end' : 'flex-start',
          }}
        >
          <strong>{labels[drawn - 1]}</strong>
          <span className="money">{formatMoney(shown[drawn - 1] ?? 0, currency)}</span>
        </div>
      )}

      {pace !== undefined && pace > 0 && paceLabel && (
        <p className="area__legend"><span className="area__legend-dash" />{paceLabel}</p>
      )}
    </div>
  );
}
