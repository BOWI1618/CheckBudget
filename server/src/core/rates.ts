import { convert, type Rate } from '@checkbudget/shared';
import { db } from '../db/index.js';

export interface ResolvedRate extends Rate {
  date: string;
  source: string;
}

/**
 * Курс на дату операции: последний известный курс с valid_on <= occurredOn.
 *
 * Никогда не берётся «текущий» курс для прошлой операции — иначе изменение
 * справочника задним числом переписывало бы историю.
 */
export function resolveRate(from: string, to: string, on: string): ResolvedRate | null {
  if (from === to) return { num: 1, den: 1, date: on, source: 'identity' };

  const direct = db.get<{ rate_num: number; rate_den: number; valid_on: string; source: string }>(
    `SELECT rate_num, rate_den, valid_on, source FROM exchange_rates
      WHERE base_code = ? AND quote_code = ? AND valid_on <= ?
      ORDER BY valid_on DESC LIMIT 1`,
    from,
    to,
    on,
  );
  if (direct) {
    return { num: direct.rate_num, den: direct.rate_den, date: direct.valid_on, source: direct.source };
  }

  // Обратная пара: RUB->USD выводится из USD->RUB переворотом дроби.
  // Точность не теряется, потому что курс — рациональное число.
  const inverse = db.get<{ rate_num: number; rate_den: number; valid_on: string; source: string }>(
    `SELECT rate_num, rate_den, valid_on, source FROM exchange_rates
      WHERE base_code = ? AND quote_code = ? AND valid_on <= ?
      ORDER BY valid_on DESC LIMIT 1`,
    to,
    from,
    on,
  );
  if (inverse) {
    return {
      num: inverse.rate_den,
      den: inverse.rate_num,
      date: inverse.valid_on,
      source: `${inverse.source}:inverse`,
    };
  }

  return null;
}

export interface Conversion {
  baseAmountMinor: number | null;
  rateNum: number | null;
  rateDen: number | null;
  rateDate: string | null;
  rateSource: string | null;
}

/**
 * Пересчитывает сумму в базовую валюту бюджета и возвращает всё, что нужно
 * для воспроизводимости расчёта. Результат замораживается в строке операции.
 *
 * Если курса на дату нет — операция всё равно создаётся, но с
 * baseAmountMinor = null. Аналитика покажет такие операции отдельно,
 * вместо того чтобы молча их потерять или подставить произвольный курс.
 */
export function convertToBase(
  amountMinor: number,
  currency: string,
  baseCurrency: string,
  occurredOn: string,
): Conversion {
  if (currency === baseCurrency) {
    return {
      baseAmountMinor: amountMinor,
      rateNum: 1,
      rateDen: 1,
      rateDate: occurredOn,
      rateSource: 'identity',
    };
  }
  const rate = resolveRate(currency, baseCurrency, occurredOn);
  if (!rate) {
    return { baseAmountMinor: null, rateNum: null, rateDen: null, rateDate: null, rateSource: null };
  }
  return {
    baseAmountMinor: convert(amountMinor, currency, baseCurrency, rate),
    rateNum: rate.num,
    rateDen: rate.den,
    rateDate: rate.date,
    rateSource: rate.source,
  };
}
