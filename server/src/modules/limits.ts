import type { FastifyInstance } from 'fastify';
import { putLimitSchema } from '@checkbudget/shared';
import { db } from '../db/index.js';
import { mutate } from '../core/events.js';
import { requireMember } from '../core/permissions.js';
import { unprocessable } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { requireAuth, parseBody, idempotent } from '../http/helpers.js';
import { m, toLimit, type LimitRow } from './mappers.js';

/**
 * Потрачено по лимиту считается в базовой валюте бюджета и включает
 * подкатегории: лимит на «Еду» покрывает «Продукты», «Рестораны» и «Кофе».
 *
 * Операции без курса (base_amount_minor IS NULL) не подмешиваются в сумму,
 * но считаются отдельно — чтобы прогресс не выглядел ложно оптимистичным.
 */
export interface LimitProgress {
  spentMinor: number;
  unconverted: number;
}

export async function limitProgress(budgetId: string, categoryId: string, period: string): Promise<LimitProgress> {
  // Границы месяца вместо извлечения месяца из даты: substr по дате
  // в Postgres не работает, а сравнение диапазоном ещё и попадает в индекс
  // (budget_id, occurred_on).
  const [year, month] = period.split('-').map(Number) as [number, number];
  const from = `${period}-01`;
  const to = `${period}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;

  const row = await db.get<{ spent: number | null; unconverted: number }>(
    `SELECT COALESCE(SUM(t.base_amount_minor), 0) AS spent,
            SUM(CASE WHEN t.base_amount_minor IS NULL THEN 1 ELSE 0 END) AS unconverted
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
      WHERE t.budget_id = ?
        AND t.type = 'expense'
        AND t.deleted_at IS NULL
        AND t.occurred_on >= ? AND t.occurred_on <= ?
        AND (c.id = ? OR c.parent_id = ?)`,
    budgetId, from, to, categoryId, categoryId,
  );
  return { spentMinor: row?.spent ?? 0, unconverted: row?.unconverted ?? 0 };
}

export async function listLimits(budgetId: string, period: string) {
  const rows = await db.all<LimitRow>(
    'SELECT * FROM budget_limits WHERE budget_id = ? AND period = ?',
    budgetId, period,
  );
  // Прогресс считается по каждой строке отдельным запросом.
  // Последовательно, а не Promise.all: на одном соединении SQLite
  // параллельность всё равно мнимая, а лимитов в месяце единицы.
  const items = [];
  for (const r of rows) {
    const progress = await limitProgress(budgetId, r.category_id, r.period);
    items.push({
      ...toLimit(r),
      spentMinor: m(progress.spentMinor),
      unconvertedCount: progress.unconverted,
    });
  }
  return items;
}

export const limitRoutes = async (app: FastifyInstance): Promise<void> => {
  app.addHook('preHandler', requireAuth);

  app.get<{ Params: { budgetId: string }; Querystring: { period?: string } }>(
    '/budgets/:budgetId/limits',
    async (req) => {
      const member = await requireMember(req.userId, req.params.budgetId);
      const period = req.query.period ?? new Date().toISOString().slice(0, 7);
      return { items: await listLimits(member.budgetId, period), period };
    },
  );

  // PUT, а не POST: лимит уникален по (бюджет, категория, период),
  // поэтому установка лимита — идемпотентная по смыслу операция upsert.
  app.put<{ Params: { budgetId: string } }>('/budgets/:budgetId/limits', async (req, reply) => {
    const member = await requireMember(req.userId, req.params.budgetId, 'editor');
    const input = parseBody(putLimitSchema, req.body);
    return idempotent(req, reply, () =>
      mutate(member.userId, async (emit) => {
        const cat = await db.get<{ id: string; kind: string }>(
          'SELECT id, kind FROM categories WHERE budget_id = ? AND id = ? AND deleted_at IS NULL',
          member.budgetId, input.categoryId,
        );
        if (!cat) throw unprocessable('unknown_category', 'Категория не найдена в этом бюджете');
        if (cat.kind !== 'expense') {
          throw unprocessable('income_category', 'Лимит можно установить только на категорию расходов');
        }

        const ts = nowIso();
        const existing = await db.get<LimitRow>(
          'SELECT * FROM budget_limits WHERE budget_id = ? AND category_id = ? AND period = ?',
          member.budgetId, input.categoryId, input.period,
        );

        if (input.limitMinor === 0 && existing) {
          await db.run('DELETE FROM budget_limits WHERE id = ?', existing.id);
          await emit({
            budgetId: member.budgetId, entity: 'limit', entityId: existing.id,
            op: 'delete', actorId: member.userId, payload: { id: existing.id },
          });
          return { ok: true, deleted: true };
        }

        const id = existing?.id ?? newId();
        if (existing) {
          await db.run(
            `UPDATE budget_limits SET limit_minor = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
            input.limitMinor, ts, id,
          );
        } else {
          await db.run(
            `INSERT INTO budget_limits (id, budget_id, category_id, period, limit_minor, currency,
                                        created_at, updated_at, version)
             VALUES (?,?,?,?,?,?,?,?,1)`,
            id, member.budgetId, input.categoryId, input.period,
            input.limitMinor, member.baseCurrency, ts, ts,
          );
        }

        const row = (await db.get<LimitRow>('SELECT * FROM budget_limits WHERE id = ?', id))!;
        const progress = await limitProgress(member.budgetId, input.categoryId, input.period);
        const payload = { ...toLimit(row), spentMinor: m(progress.spentMinor), unconvertedCount: progress.unconverted };
        await emit({
          budgetId: member.budgetId, entity: 'limit', entityId: id,
          op: existing ? 'update' : 'insert', actorId: member.userId, payload,
        });
        return payload;
      }),
    );
  });
};
