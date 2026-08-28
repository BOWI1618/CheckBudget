/**
 * Справочник валют. `exponent` — количество знаков после запятой,
 * то есть 10^exponent минорных единиц в одной мажорной.
 *
 * Добавление валюты — это одна строка здесь плюс строка в таблице `currencies`.
 * Никакой код менять не нужно.
 */
export interface Currency {
  code: string;
  nameRu: string;
  symbol: string;
  exponent: number;
}

export const CURRENCIES: readonly Currency[] = [
  { code: 'RUB', nameRu: 'Российский рубль', symbol: '₽', exponent: 2 },
  { code: 'USD', nameRu: 'Доллар США', symbol: '$', exponent: 2 },
  { code: 'EUR', nameRu: 'Евро', symbol: '€', exponent: 2 },
  { code: 'GBP', nameRu: 'Фунт стерлингов', symbol: '£', exponent: 2 },
  { code: 'CNY', nameRu: 'Китайский юань', symbol: '¥', exponent: 2 },
  { code: 'KZT', nameRu: 'Казахстанский тенге', symbol: '₸', exponent: 2 },
  { code: 'TRY', nameRu: 'Турецкая лира', symbol: '₺', exponent: 2 },
  { code: 'AED', nameRu: 'Дирхам ОАЭ', symbol: 'د.إ', exponent: 2 },
  { code: 'CHF', nameRu: 'Швейцарский франк', symbol: 'Fr', exponent: 2 },
  { code: 'JPY', nameRu: 'Японская иена', symbol: '¥', exponent: 0 },
] as const;

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));

export function getCurrency(code: string): Currency {
  const c = BY_CODE.get(code);
  if (!c) throw new Error(`Неизвестная валюта: ${code}`);
  return c;
}

export function isKnownCurrency(code: string): boolean {
  return BY_CODE.has(code);
}

export const DEFAULT_CURRENCY = 'RUB';
