import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { requireMember } from '../core/permissions.js';
import { requireAuth } from '../http/helpers.js';
import { m } from './mappers.js';

/**
 * Вся аналитика считается по base_amount_minor — сумме, замороженной в момент
 * записи операции. Поэтому отчёт за прошлый месяц не «поедет» после обновления
 * курсов, а сумма по категориям всегда сходится с итогом.
 *
 * Переводы (type = 'transfer') исключены из доходов и расходов: перекладывание
 * денег между своими счетами не меняет благосостояние.
 */

const defaultRange = () => {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  return { from, to };
};

export const analyticsRoutes = async (app: FastifyInstance): Promise<void> => {
  app.addHook('preHandler', requireAuth);

  app.get<{ Params: { budgetId: string }; Querystring: { from?: string; to?: string } }>(
    '/budgets/:budgetId/analytics/summary',
    async (req) => {
      const member = await requireMember(req.userId, req.params.budgetId);
      const { from, to } = { ...defaultRange(), ...req.query };
      const row = (await db.get<{ income: number; expense: number; unconverted: number }>(
        `SELECT
           COALESCE(SUM(CASE WHEN type = 'income'  THEN base_amount_minor ELSE 0 END), 0) AS income,
           COALESCE(SUM(CASE WHEN type = 'expense' THEN base_amount_minor ELSE 0 END), 0) AS expense,
           SUM(CASE WHEN base_amount_minor IS NULL AND type <> 'transfer' THEN 1 ELSE 0 END) AS unconverted
         FROM transactions
        WHERE budget_id = ? AND deleted_at IS NULL AND occurred_on BETWEEN ? AND ?`,
        member.budgetId, from, to,
      ))!;
      return {
        from, to,
        baseCurrency: member.baseCurrency,
        incomeMinor: m(row.income),
        expenseMinor: m(row.expense),
        netMinor: m(row.income - row.expense),
        unconvertedCount: row.unconverted ?? 0,
      };
    },
  );

  app.get<{
    Params: { budgetId: string };
    Querystring: { from?: string; to?: string; kind?: 'expense' | 'income' };
  }>('/budgets/:budgetId/analytics/by-category', async (req) => {
    const member = await requireMember(req.userId, req.params.budgetId);
    const { from, to } = { ...defaultRange(), ...req.query };
    const kind = req.query.kind === 'income' ? 'income' : 'expense';

    // Группировка по КОРНЕВОЙ категории: «Продукты» и «Рестораны» сливаются
    // в «Еду». Разбивка по подкатегориям доступна отдельным запросом с
    // фильтром categoryId — так дашборд остаётся читаемым.
    const rows = await db.all<{
      root_id: string; name: string; color: string; icon: string; total: number; cnt: number;
    }>(
      `SELECT COALESCE(p.id, c.id)     AS root_id,
              COALESCE(p.name, c.name) AS name,
              COALESCE(p.color, c.color) AS color,
              COALESCE(p.icon, c.icon)   AS icon,
              SUM(t.base_amount_minor)   AS total,
              COUNT(*)                   AS cnt
         FROM transactions t
         JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories p ON p.id = c.parent_id
        WHERE t.budget_id = ? AND t.type = ? AND t.deleted_at IS NULL
          AND t.base_amount_minor IS NOT NULL
          AND t.occurred_on BETWEEN ? AND ?
     GROUP BY COALESCE(p.id, c.id), COALESCE(p.name, c.name),
              COALESCE(p.color, c.color), COALESCE(p.icon, c.icon)
     ORDER BY total DESC`,
      member.budgetId, kind, from, to,
    );

    return {
      from, to, kind,
      baseCurrency: member.baseCurrency,
      items: rows.map((r) => ({
        categoryId: r.root_id,
        name: r.name,
        color: r.color,
        icon: r.icon,
        amountMinor: m(r.total),
        count: r.cnt,
      })),
    };
  });

  app.get<{
    Params: { budgetId: string };
    Querystring: { from?: string; to?: string; granularity?: 'day' | 'month' };
  }>('/budgets/:budgetId/analytics/timeseries', async (req) => {
    const member = await requireMember(req.userId, req.params.budgetId);
    const { from, to } = { ...defaultRange(), ...req.query };
    const granularity = req.query.granularity === 'month' ? 'month' : 'day';
    // CAST к тексту обязателен: в Postgres occurred_on имеет тип DATE,
    // и substr по нему не существует. В SQLite приведение безвредно.
    const bucket = granularity === 'month'
      ? "substr(CAST(occurred_on AS TEXT), 1, 7)"
      : 'CAST(occurred_on AS TEXT)';

    const rows = await db.all<{ bucket: string; income: number; expense: number }>(
      `SELECT ${bucket} AS bucket,
              COALESCE(SUM(CASE WHEN type = 'income'  THEN base_amount_minor ELSE 0 END), 0) AS income,
              COALESCE(SUM(CASE WHEN type = 'expense' THEN base_amount_minor ELSE 0 END), 0) AS expense
         FROM transactions
        WHERE budget_id = ? AND deleted_at IS NULL AND occurred_on BETWEEN ? AND ?
          AND base_amount_minor IS NOT NULL
     GROUP BY bucket ORDER BY bucket`,
      member.budgetId, from, to,
    );

    return {
      from, to, granularity,
      baseCurrency: member.baseCurrency,
      items: rows.map((r) => ({
        bucket: r.bucket,
        incomeMinor: m(r.income),
        expenseMinor: m(r.expense),
      })),
    };
  });

  app.get<{ Params: { budgetId: string }; Querystring: { from?: string; to?: string; limit?: string } }>(
    '/budgets/:budgetId/analytics/top-expenses',
    async (req) => {
      const member = await requireMember(req.userId, req.params.budgetId);
      const { from, to } = { ...defaultRange(), ...req.query };
      const limit = Math.min(Number(req.query.limit ?? 5) || 5, 50);
      const rows = await db.all<{
        id: string; base_amount_minor: number; amount_minor: number; currency: string;
        occurred_on: string; note: string | null; name: string; color: string; icon: string;
      }>(
        `SELECT t.id, t.base_amount_minor, t.amount_minor, t.currency, t.occurred_on, t.note,
                c.name, c.color, c.icon
           FROM transactions t
           JOIN categories c ON c.id = t.category_id
          WHERE t.budget_id = ? AND t.type = 'expense' AND t.deleted_at IS NULL
            AND t.base_amount_minor IS NOT NULL AND t.occurred_on BETWEEN ? AND ?
       ORDER BY t.base_amount_minor DESC LIMIT ?`,
        member.budgetId, from, to, limit,
      );
      return {
        baseCurrency: member.baseCurrency,
        items: rows.map((r) => ({
          id: r.id,
          amountMinor: m(r.amount_minor),
          currency: r.currency,
          baseAmountMinor: m(r.base_amount_minor),
          occurredOn: r.occurred_on,
          note: r.note,
          categoryName: r.name,
          color: r.color,
          icon: r.icon,
        })),
      };
    },
  );
};
