import { CURRENCIES, parseRate } from '@checkbudget/shared';
import { db } from './index.js';
import { newId, nowIso, today } from '../core/ids.js';

/**
 * Справочник валют и стартовые курсы.
 *
 * В проде курсы тянет ежедневная задача (ЦБ РФ для рублёвых бюджетов, ECB для
 * остальных) и пишет их с указанием source и valid_on. Здесь — стартовый набор,
 * чтобы конвертация работала сразу после установки.
 */
const SEED_RATES: Array<[string, string, string]> = [
  ['USD', 'RUB', '92.4567'],
  ['EUR', 'RUB', '100.1234'],
  ['GBP', 'RUB', '117.8900'],
  ['CNY', 'RUB', '12.7350'],
  ['KZT', 'RUB', '0.1930'],
  ['TRY', 'RUB', '2.7100'],
  ['AED', 'RUB', '25.1700'],
  ['CHF', 'RUB', '104.5600'],
  ['JPY', 'RUB', '0.6150'],
];

export function seedReference(): void {
  db.tx(() => {
    for (const c of CURRENCIES) {
      db.run(
        `INSERT INTO currencies (code, name_ru, symbol, exponent, is_active) VALUES (?,?,?,?,1)
         ON CONFLICT(code) DO UPDATE SET name_ru = excluded.name_ru,
                                         symbol = excluded.symbol,
                                         exponent = excluded.exponent`,
        c.code, c.nameRu, c.symbol, c.exponent,
      );
    }

    const validOn = '2020-01-01'; // стартовый курс действует «с начала времён»
    for (const [base, quote, value] of SEED_RATES) {
      const rate = parseRate(value);
      db.run(
        `INSERT OR IGNORE INTO exchange_rates
           (id, base_code, quote_code, rate_num, rate_den, valid_on, source, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        newId(), base, quote, rate.num, rate.den, validOn, 'seed', nowIso(),
      );
    }
  });
}

if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  db.migrate();
  seedReference();
  console.log(`Справочники загружены (${CURRENCIES.length} валют, ${SEED_RATES.length} курсов), дата ${today()}`);
}
