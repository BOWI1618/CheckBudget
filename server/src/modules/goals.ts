import type { FastifyInstance } from 'fastify';
import { createGoalSchema, updateGoalSchema, deleteSchema } from '@checkbudget/shared';
import { db } from '../db/index.js';
import { mutate } from '../core/events.js';
import { requireMember } from '../core/permissions.js';
import { notFound, VersionConflictError } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { requireAuth, parseBody, idempotent } from '../http/helpers.js';
import { toGoal, type GoalRow } from './mappers.js';

export const listGoals = (budgetId: string): GoalRow[] =>
  db.all<GoalRow>(
    'SELECT * FROM goals WHERE budget_id = ? AND deleted_at IS NULL ORDER BY due_on IS NULL, due_on, name',
    budgetId,
  );

function findGoal(budgetId: string, id: string): GoalRow {
  const row = db.get<GoalRow>(
    'SELECT * FROM goals WHERE budget_id = ? AND id = ? AND deleted_at IS NULL',
    budgetId, id,
  );
  if (!row) throw notFound('Цель не найдена');
  return row;
}

export const goalRoutes = async (app: FastifyInstance): Promise<void> => {
  app.addHook('preHandler', requireAuth);

  app.get<{ Params: { budgetId: string } }>('/budgets/:budgetId/goals', async (req) => {
    const member = requireMember(req.userId, req.params.budgetId);
    return { items: listGoals(member.budgetId).map(toGoal) };
  });

  app.post<{ Params: { budgetId: string } }>('/budgets/:budgetId/goals', async (req, reply) => {
    const member = requireMember(req.userId, req.params.budgetId, 'editor');
    const input = parseBody(createGoalSchema, req.body);
    return idempotent(
      req, reply,
      () => mutate((emit) => {
        const id = newId();
        const ts = nowIso();
        db.run(
          `INSERT INTO goals (id, budget_id, name, target_minor, saved_minor, currency,
                              due_on, icon, color, created_at, updated_at, version)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
          id, member.budgetId, input.name, input.targetMinor, input.savedMinor,
          input.currency, input.dueOn, input.icon, input.color, ts, ts,
        );
        const row = toGoal(findGoal(member.budgetId, id));
        emit({ budgetId: member.budgetId, entity: 'goal', entityId: id, op: 'insert', actorId: member.userId, payload: row });
        return row;
      }),
      201,
    );
  });

  app.patch<{ Params: { budgetId: string; id: string } }>(
    '/budgets/:budgetId/goals/:id',
    async (req, reply) => {
      const member = requireMember(req.userId, req.params.budgetId, 'editor');
      const input = parseBody(updateGoalSchema, req.body);
      const { id } = req.params;
      return idempotent(req, reply, () =>
        mutate((emit) => {
          const current = findGoal(member.budgetId, id);
          if (current.version !== input.version) throw new VersionConflictError(toGoal(current));
          const ts = nowIso();
          const { changes } = db.run(
            `UPDATE goals SET name = ?, target_minor = ?, saved_minor = ?, due_on = ?, icon = ?, color = ?,
                              updated_at = ?, version = version + 1
              WHERE budget_id = ? AND id = ? AND version = ?`,
            input.name ?? current.name,
            input.targetMinor ?? current.target_minor,
            input.savedMinor ?? current.saved_minor,
            input.dueOn !== undefined ? input.dueOn : current.due_on,
            input.icon ?? current.icon, input.color ?? current.color,
            ts, member.budgetId, id, input.version,
          );
          if (changes === 0) throw new VersionConflictError(toGoal(findGoal(member.budgetId, id)));
          const row = toGoal(findGoal(member.budgetId, id));
          emit({ budgetId: member.budgetId, entity: 'goal', entityId: id, op: 'update', actorId: member.userId, payload: row });
          return row;
        }),
      );
    },
  );

  app.delete<{ Params: { budgetId: string; id: string } }>(
    '/budgets/:budgetId/goals/:id',
    async (req, reply) => {
      const member = requireMember(req.userId, req.params.budgetId, 'editor');
      const { version } = parseBody(deleteSchema, req.body);
      const { id } = req.params;
      return idempotent(req, reply, () =>
        mutate((emit) => {
          const current = findGoal(member.budgetId, id);
          if (current.version !== version) throw new VersionConflictError(toGoal(current));
          const ts = nowIso();
          db.run(
            `UPDATE goals SET deleted_at = ?, updated_at = ?, version = version + 1
              WHERE budget_id = ? AND id = ? AND version = ?`,
            ts, ts, member.budgetId, id, version,
          );
          emit({ budgetId: member.budgetId, entity: 'goal', entityId: id, op: 'delete', actorId: member.userId, payload: { id } });
          return { ok: true };
        }),
      );
    },
  );
};
