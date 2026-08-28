import { getCurrency } from './currencies.js';

/**
 * Денежная величина. Сумма — ВСЕГДА целое число минорных единиц.
 * Никаких float ни на одном этапе: ни в хранении, ни в транспорте, ни в расчётах.
 */
export interface Money {
  /** Целое число минорных единиц (копейки, центы). Может быть отрицательным. */
  minor: number;
  currency: string;
}

/**
 * Максимальная сумма одной операции: 10^15 минорных единиц.
 * Гарантирует, что значение помещается в Number.MAX_SAFE_INTEGER (9.007×10^15)
 * и клиенту не нужен BigInt для отображения и суммирования.
 */
export const MAX_MINOR = 1_000_000_000_000_000;

export function money(minor: number, currency: string): Money {
  return { minor, currency };
}

export function assertValidMinor(minor: number): void {
  if (!Number.isSafeInteger(minor)) {
    throw new Error('Сумма должна быть целым числом минорных единиц');
  }
  if (Math.abs(minor) > MAX_MINOR) {
    throw new Error('Сумма превышает допустимый предел');
  }
}

/** Курс как рациональное число. Никогда не float. */
export interface Rate {
  num: number;
  den: number;
}

/**
 * Парсит десятичный курс из строки в дробь без потери точности.
 * "92.4567" -> { num: 924567, den: 10000 }
 */
export function parseRate(input: string): Rate {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Некорректный курс: ${input}`);
  const dot = s.indexOf('.');
  if (dot === -1) return { num: Number(s), den: 1 };
  const decimals = s.length - dot - 1;
  return { num: Number(s.slice(0, dot) + s.slice(dot + 1)), den: 10 ** decimals };
}

/** Деление с округлением half-up, выполняется в BigInt. */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('Деление на ноль в конвертации валют');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = n / d;
  const rem = n % d;
  const rounded = rem * 2n >= d ? q + 1n : q;
  return negative ? -rounded : rounded;
}

/**
 * Конвертация суммы в другую валюту по заданному курсу.
 *
 *                  amount × rate.num × 10^exp(to)
 *   result = round( ──────────────────────────────── )
 *                     rate.den × 10^exp(from)
 *
 * Вся арифметика в BigInt, округление выполняется ровно один раз — в конце.
 */
export function convert(amountMinor: number, from: string, to: string, rate: Rate): number {
  assertValidMinor(amountMinor);
  if (from === to) return amountMinor;
  const expFrom = BigInt(getCurrency(from).exponent);
  const expTo = BigInt(getCurrency(to).exponent);
  const numerator = BigInt(amountMinor) * BigInt(rate.num) * 10n ** expTo;
  const denominator = BigInt(rate.den) * 10n ** expFrom;
  const result = divRoundHalfUp(numerator, denominator);
  const out = Number(result);
  assertValidMinor(out);
  return out;
}

/** Разбирает пользовательский ввод ("2 500,50") в минорные единицы. */
export function parseAmount(input: string, currency: string): number {
  const exp = getCurrency(currency).exponent;
  const cleaned = input.replace(/\s| /g, '').replace(',', '.');
  if (cleaned === '' || !/^-?\d*(\.\d*)?$/.test(cleaned)) {
    throw new Error('Некорректная сумма');
  }
  const negative = cleaned.startsWith('-');
  const body = negative ? cleaned.slice(1) : cleaned;
  const dot = body.indexOf('.');
  const whole = dot === -1 ? body : body.slice(0, dot);
  let frac = dot === -1 ? '' : body.slice(dot + 1);
  if (frac.length > exp) {
    // Округляем half-up на уровне строки, чтобы не проходить через float.
    const keep = frac.slice(0, exp);
    const nextDigit = Number(frac[exp] ?? '0');
    let value = BigInt((whole || '0') + (keep || '')) ;
    if (nextDigit >= 5) value += 1n;
    const out = Number(value);
    assertValidMinor(out);
    return negative ? -out : out;
  }
  frac = frac.padEnd(exp, '0');
  const out = Number((whole || '0') + frac);
  assertValidMinor(out);
  return negative ? -out : out;
}

/** Неразрывный пробел — разряды не должны переноситься на другую строку. */
export const NBSP = '\u00A0';

/** Группировка разрядов без зависимости от ICU: 1234567 -> "1 234 567". */
function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** Форматирует минорные единицы для отображения: 250000 RUB -> "2 500 ₽". */
export function formatMoney(
  minor: number,
  currency: string,
  opts: { showFraction?: 'auto' | 'always' | 'never'; sign?: boolean } = {},
): string {
  const { exponent, symbol } = getCurrency(currency);
  const showFraction = opts.showFraction ?? 'auto';
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const divisor = 10 ** exponent;
  const whole = Math.trunc(abs / divisor);
  const frac = abs % divisor;

  const wholeStr = whole.toLocaleString('ru-RU').replace(/,/g, ' ');
  const needFraction =
    showFraction === 'always' || (showFraction === 'auto' && frac !== 0 && exponent > 0);
  const fracStr = needFraction ? ',' + String(frac).padStart(exponent, '0') : '';

  const signStr = negative ? '−' : opts.sign ? '+' : '';
  return `${signStr}${wholeStr}${fracStr} ${symbol}`;
}

/** Компактный формат для графиков: 184320 -> "1,8 тыс." */
export function formatCompact(minor: number, currency: string): string {
  const { exponent } = getCurrency(currency);
  const value = Math.abs(minor) / 10 ** exponent;
  const sign = minor < 0 ? '−' : '';
  if (value >= 1_000_000) return `${sign}${(value / 1_000_000).toFixed(1).replace('.', ',')}${NBSP}млн`;
  if (value >= 10_000) return `${sign}${groupDigits(Math.round(value / 1000))}${NBSP}тыс.`;
  if (value >= 1_000) return `${sign}${(value / 1000).toFixed(1).replace('.', ',')}${NBSP}тыс.`;
  return `${sign}${groupDigits(Math.round(value))}`;
}

/** Сумма в формате поля ввода: 250050 -> "2500,50" */
export function toInputValue(minor: number, currency: string): string {
  const exp = getCurrency(currency).exponent;
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / 10 ** exp);
  if (exp === 0) return String(whole);
  const frac = String(abs % 10 ** exp).padStart(exp, '0');
  return `${whole},${frac}`;
}
