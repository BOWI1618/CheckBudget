import { useEffect, useRef, useState } from 'react';
import { formatMoney } from '@checkbudget/shared';

/**
 * Денежная сумма, которая переходит к новому значению, а не подменяется.
 *
 * Это не украшение. Баланс и итоги меняются от событий, пришедших с ДРУГОГО
 * устройства: жена добавила расход с телефона — на ноутбуке число просто
 * стало другим. Мгновенная подмена не оставляет следа, и человек не понимает,
 * что именно изменилось и изменилось ли вообще. Переход показывает и факт
 * изменения, и его направление.
 *
 * Анимируется значение, а не текст: форматирование остаётся тем же самым
 * (разряды, минус, символ валюты), поэтому число не «дрожит» по ширине —
 * этому помогает и табличная разрядка цифр в шрифте.
 */
export function AnimatedNumber({
  value,
  currency,
  sign,
  showFraction,
  duration = 560,
  className = '',
}: {
  value: number;
  currency: string;
  sign?: boolean;
  showFraction?: 'auto' | 'always' | 'never';
  duration?: number;
  className?: string;
}) {
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const from = fromRef.current;
    if (from === value) return;

    // Уважение к системной настройке: для тех, кому движение мешает,
    // значение меняется мгновенно.
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      fromRef.current = value;
      setShown(value);
      return;
    }

    const started = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / duration);
      // Та же кривая, что и у остального движения в приложении:
      // быстрый выход и мягкое оседание.
      const eased = 1 - Math.pow(1 - t, 4);
      setShown(Math.round(from + (value - from) * eased));
      if (t < 1) frameRef.current = requestAnimationFrame(step);
      else fromRef.current = value;
    };

    frameRef.current = requestAnimationFrame(step);

    // В фоновой вкладке кадры не выдаются, и значение застряло бы на старом.
    // Страховка доводит его до конечного: увидеть неверную сумму хуже,
    // чем не увидеть перехода.
    const fallback = setTimeout(() => {
      fromRef.current = value;
      setShown(value);
    }, duration + 120);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      clearTimeout(fallback);
      fromRef.current = value;
    };
  }, [value, duration]);

  return (
    <span className={`money ${className}`}>
      {formatMoney(shown, currency, { sign, showFraction })}
    </span>
  );
}
