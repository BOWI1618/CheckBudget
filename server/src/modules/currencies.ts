import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { today } from '../core/ids.js';

export const currencyRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/currencies', async () => ({
    items: db.all<{ code: string; name_ru: string; symbol: string; exponent: number }>(
      'SELECT code, name_ru, symbol, exponent FROM currencies WHERE is_active = 1 ORDER BY code',
    ).map((r) => ({ code: r.code, nameRu: r.name_ru, symbol: r.symbol, exponent: r.exponent })),
  }));

  app.get<{ Querystring: { base?: string; on?: string } }>('/rates', async (req) => {
    const base = (req.query.base ?? 'RUB').toUpperCase();
    const on = req.query.on ?? today();
    // Курс отдаётся дробью, а не десятичным числом: клиент не должен
    // получать возможность делать конвертацию во float.
    const items = db.all<{ quote_code: string; rate_num: number; rate_den: number; valid_on: string; source: string }>(
      `SELECT quote_code, rate_num, rate_den, valid_on, source FROM exchange_rates r
        WHERE base_code = ? AND valid_on <= ?
          AND valid_on = (SELECT MAX(valid_on) FROM exchange_rates
                           WHERE base_code = r.base_code AND quote_code = r.quote_code AND valid_on <= ?)`,
      base, on, on,
    );
    return { base, on, items };
  });
};
