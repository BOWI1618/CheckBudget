import type { FastifyInstance } from 'fastify';
import { createAccountSchema, updateAccountSchema, deleteSchema } from '@checkbudget/shared';
import { db } from '../db/index.js';
import { mutate } from '../core/events.js';
import { requireMember } from '../core/permissions.js';
import { notFound, unprocessable, VersionConflictError } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { requireAuth, parseBody, idempotent } from '../http/helpers.js';
import { toAccount, type AccountRow } from './mappers.js';

/**
 * Баланс счёта ВЫЧИСЛЯЕТСЯ, а не хранится.
 *
 * Хранимый баланс — денормализация, которая рассинхронизируется при первой же
 * гонке двух устройств. Путь оптимизации, когда объём вырастет:
 * материализованный снимок на конец месяца + дельта с начала месяца.
 */
export const ACCOUNTS_SELECT = `
  SELECT a.*,
         a.initial_balance_minor
         + COALESCE((SELECT SUM(CASE t.type
                                  WHEN 'income'   THEN  t.amount_minor
                                  WHEN 'expense'  THEN -t.amount_minor
                                  WHEN 'transfer' THEN -t.amount_minor
                                END)
                       FROM transactions t
                      WHERE t.budget_id = a.budget_id
                        AND t.account_id = a.id
                        AND t.deleted_at IS NULL), 0)
         + COALESCE((SELECT SUM(t.counter_amount_minor)
                       FROM transactions t
                      WHERE t.budget_id = a.budget_id
                        AND t.counter_account_id = a.id
                        AND t.type = 'transfer'
                        AND t.deleted_at IS NULL), 0)
         AS balance_minor
    FROM accounts a`;

export function listAccounts(budgetId: string): AccountRow[] {
  return db.all<AccountRow>(
    `${ACCOUNTS_SELECT} WHERE a.budget_id = ? AND a.deleted_at IS NULL
      ORDER BY a.is_archived, a.sort_order, a.name`,
    budgetId,
  );
}

function findAccount(budgetId: string, id: string): AccountRow {
  const row = db.get<AccountRow>(
    `${ACCOUNTS_SELECT} WHERE a.budget_id = ? AND a.id = ? AND a.deleted_at IS NULL`,
    budgetId,
    id,
  );
  if (!row) throw notFound('Счёт не найден');
  return row;
}

export const accountRoutes = async (app: FastifyInstance): Promise<void> => {
  app.addHook('preHandler', requireAuth);

  app.get<{ Params: { budgetId: string } }>('/budgets/:budgetId/accounts', async (req) => {
    const member = requireMember(req.userId, req.params.budgetId);
    return { items: listAccounts(member.budgetId).map(toAccount) };
  });

  app.post<{ Params: { budgetId: string } }>('/budgets/:budgetId/accounts', async (req, reply) => {
    const member = requireMember(req.userId, req.params.budgetId, 'editor');
    const input = parseBody(createAccountSchema, req.body);
    return idempotent(
      req,
      reply,
      () =>
        mutate((emit) => {
          const id = newId();
          const ts = nowIso();
          const maxOrder = db.get<{ n: number | null }>(
            'SELECT MAX(sort_order) AS n FROM accounts WHERE budget_id = ?',
            member.budgetId,
          )?.n ?? 0;
          db.run(
            `INSERT INTO accounts (id, budget_id, name, type, currency, initial_balance_minor,
                                   color, icon, sort_order, created_at, updated_at, version)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
            id, member.budgetId, input.name, input.type, input.currency,
            input.initialBalanceMinor, input.color, input.icon, maxOrder + 1, ts, ts,
          );
          const row = findAccount(member.budgetId, id);
          emit({
            budgetId: member.budgetId, entity: 'account', entityId: id,
            op: 'insert', actorId: member.userId, payload: toAccount(row),
          });
          return toAccount(row);
        }),
      201,
    );
  });

  app.patch<{ Params: { budgetId: string; id: string } }>(
    '/budgets/:budgetId/accounts/:id',
    async (req, reply) => {
      const member = requireMember(req.userId, req.params.budgetId, 'editor');
      const input = parseBody(updateAccountSchema, req.body);
      const { id } = req.params;
      return idempotent(req, reply, () =>
        mutate((emit) => {
          const current = findAccount(member.budgetId, id);
          if (current.version !== input.version) throw new VersionConflictError(toAccount(current));
          const ts = nowIso();
          const { changes } = db.run(
            `UPDATE accounts SET name = ?, type = ?, initial_balance_minor = ?, color = ?, icon = ?,
                                 is_archived = ?, updated_at = ?, version = version + 1
              WHERE budget_id = ? AND id = ? AND version = ?`,
            input.name ?? current.name,
            input.type ?? current.type,
            input.initialBalanceMinor ?? current.initial_balance_minor,
            input.color ?? current.color,
            input.icon ?? current.icon,
            input.isArchived === undefined ? current.is_archived : input.isArchived ? 1 : 0,
            ts, member.budgetId, id, input.version,
          );
          if (changes === 0) throw new VersionConflictError(toAccount(findAccount(member.budgetId, id)));
          const row = findAccount(member.budgetId, id);
          emit({
            budgetId: member.budgetId, entity: 'account', entityId: id,
            op: 'update', actorId: member.userId, payload: toAccount(row),
          });
          return toAccount(row);
        }),
      );
    },
  );

  app.delete<{ Params: { budgetId: string; id: string } }>(
    '/budgets/:budgetId/accounts/:id',
    async (req, reply) => {
      const member = requireMember(req.userId, req.params.budgetId, 'editor');
      const { version } = parseBody(deleteSchema, req.body);
      const { id } = req.params;
      return idempotent(req, reply, () =>
        mutate((emit) => {
          const current = findAccount(member.budgetId, id);
          if (current.version !== version) throw new VersionConflictError(toAccount(current));

          // Счёт с операциями удалять нельзя — это уничтожило бы историю.
          // Вместо удаления предлагается архивация: счёт исчезает из выбора,
          // но операции и балансы остаются корректными.
          const used = db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM transactions
              WHERE budget_id = ? AND (account_id = ? OR counter_account_id = ?) AND deleted_at IS NULL`,
            member.budgetId, id, id,
          )?.n ?? 0;
          if (used > 0) {
            throw unprocessable(
              'account_in_use',
              `На счёте ${used} операц. — его можно архивировать, но не удалить`,
            );
          }

          const ts = nowIso();
          db.run(
            `UPDATE accounts SET deleted_at = ?, updated_at = ?, version = version + 1
              WHERE budget_id = ? AND id = ? AND version = ?`,
            ts, ts, member.budgetId, id, version,
          );
          emit({
            budgetId: member.budgetId, entity: 'account', entityId: id,
            op: 'delete', actorId: member.userId, payload: { id, version: version + 1 },
          });
          return { ok: true };
        }),
      );
    },
  );
};
