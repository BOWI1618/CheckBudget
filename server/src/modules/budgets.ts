import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import {
  createBudgetSchema, updateBudgetSchema, createInviteSchema,
  acceptInviteSchema, updateMemberSchema, type Role,
} from '@checkbudget/shared';
import { db } from '../db/index.js';
import { mutate } from '../core/events.js';
import { requireMember } from '../core/permissions.js';
import { notFound, unprocessable, VersionConflictError, forbidden } from '../core/errors.js';
import { newId, newInviteCode, nowIso } from '../core/ids.js';
import { currentSeq } from '../core/events.js';
import { requireAuth, parseBody, idempotent } from '../http/helpers.js';
import { seedBudgetDefaults } from './defaults.js';
import { listAccounts } from './accounts.js';
import { listCategories } from './categories.js';
import { listGoals } from './goals.js';
import { listLimits } from './limits.js';
import { toAccount, toCategory, toGoal, toTransaction, type TransactionRow } from './mappers.js';

const hashCode = (code: string): string =>
  createHash('sha256').update(code.toUpperCase().replace(/\s/g, '')).digest('hex');

export async function listMembers(budgetId: string) {
  return (await db.all<{ user_id: string; role: Role; joined_at: string; display_name: string; email: string }>(
    `SELECT m.user_id, m.role, m.joined_at, u.display_name, u.email
       FROM budget_members m JOIN users u ON u.id = m.user_id
      WHERE m.budget_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.display_name`,
    budgetId,
  )).map((r) => ({
    userId: r.user_id,
    role: r.role,
    joinedAt: r.joined_at,
    displayName: r.display_name,
    email: r.email,
  }));
}

export const budgetRoutes = async (app: FastifyInstance): Promise<void> => {
  app.addHook('preHandler', requireAuth);

  app.get('/budgets', async (req) => {
    const rows = await db.all<{
      id: string; name: string; base_currency: string; owner_id: string;
      role: Role; created_at: string; updated_at: string; version: number;
    }>(
      `SELECT b.id, b.name, b.base_currency, b.owner_id, m.role, b.created_at, b.updated_at, b.version
         FROM budgets b JOIN budget_members m ON m.budget_id = b.id
        WHERE m.user_id = ? AND b.archived_at IS NULL
        ORDER BY b.created_at`,
      req.userId,
    );
    return {
      items: rows.map((r) => ({
        id: r.id, name: r.name, baseCurrency: r.base_currency, ownerId: r.owner_id,
        role: r.role, createdAt: r.created_at, updatedAt: r.updated_at, version: r.version,
      })),
    };
  });

  app.post('/budgets', async (req, reply) => {
    const input = parseBody(createBudgetSchema, req.body);
    return idempotent(
      req, reply,
      () => mutate(req.userId, async () => {
        const id = newId();
        const ts = nowIso();
        await db.run(
          `INSERT INTO budgets (id, name, base_currency, owner_id, created_at, updated_at, version)
           VALUES (?,?,?,?,?,?,1)`,
          id, input.name, input.baseCurrency, req.userId, ts, ts,
        );
        await db.run(
          'INSERT INTO budget_members (budget_id, user_id, role, joined_at) VALUES (?,?,?,?)',
          id, req.userId, 'owner', ts,
        );
        await seedBudgetDefaults(id, input.baseCurrency);
        return {
          id, name: input.name, baseCurrency: input.baseCurrency, ownerId: req.userId,
          role: 'owner' as const, createdAt: ts, updatedAt: ts, version: 1,
        };
      }),
      201,
    );
  });

  app.patch<{ Params: { budgetId: string } }>('/budgets/:budgetId', async (req, reply) => {
    const member = await requireMember(req.userId, req.params.budgetId, 'owner');
    const input = parseBody(updateBudgetSchema, req.body);
    return idempotent(req, reply, () =>
      mutate(req.userId, async (emit) => {
        const ts = nowIso();
        const { changes } = await db.run(
          'UPDATE budgets SET name = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?',
          input.name ?? member.budgetName, ts, member.budgetId, input.version,
        );
        if (changes === 0) {
          const current = await db.get('SELECT * FROM budgets WHERE id = ?', member.budgetId);
          throw new VersionConflictError(current);
        }
        const payload = { id: member.budgetId, name: input.name ?? member.budgetName, version: input.version + 1 };
        await emit({
          budgetId: member.budgetId, entity: 'budget', entityId: member.budgetId,
          op: 'update', actorId: req.userId, payload,
        });
        return payload;
      }),
    );
  });

  /**
   * Полный снимок бюджета — единственный запрос, который нужен клиенту
   * при холодном старте. Возвращает seq, от которого дальше идёт realtime.
   */
  app.get<{ Params: { budgetId: string }; Querystring: { from?: string; to?: string } }>(
    '/budgets/:budgetId/snapshot',
    async (req) => {
      const member = await requireMember(req.userId, req.params.budgetId);
      const now = new Date();
      const from = req.query.from
        ?? new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1)).toISOString().slice(0, 10);
      const to = req.query.to ?? '9999-12-31';

      // seq читается ПЕРЕД данными: если между чтением seq и чтением данных
      // придёт новое событие, клиент получит его повторно — это безопасно
      // (события идемпотентны при применении), а вот пропуск был бы не безопасен.
      const seq = await currentSeq(member.budgetId);

      const transactions = await db.all<TransactionRow>(
        `SELECT * FROM transactions
          WHERE budget_id = ? AND deleted_at IS NULL AND occurred_on BETWEEN ? AND ?
          ORDER BY occurred_on DESC, id DESC LIMIT 2000`,
        member.budgetId, from, to,
      );

      return {
        seq,
        budget: {
          id: member.budgetId,
          name: member.budgetName,
          baseCurrency: member.baseCurrency,
          role: member.role,
        },
        range: { from, to },
        accounts: (await listAccounts(member.budgetId)).map(toAccount),
        categories: (await listCategories(member.budgetId)).map(toCategory),
        transactions: transactions.map(toTransaction),
        limits: await listLimits(member.budgetId, new Date().toISOString().slice(0, 7)),
        goals: (await listGoals(member.budgetId)).map(toGoal),
        members: await listMembers(member.budgetId),
      };
    },
  );

  // ───────────────────────────── Участники ─────────────────────────────

  app.get<{ Params: { budgetId: string } }>('/budgets/:budgetId/members', async (req) => {
    const member = await requireMember(req.userId, req.params.budgetId);
    return { items: await listMembers(member.budgetId) };
  });

  app.post<{ Params: { budgetId: string } }>('/budgets/:budgetId/invites', async (req, reply) => {
    const member = await requireMember(req.userId, req.params.budgetId, 'owner');
    const input = parseBody(createInviteSchema, req.body);
    return idempotent(
      req, reply,
      async () => {
        // Код существует только в этом ответе: в БД лежит его SHA-256.
        // Утечка дампа базы не даёт возможности присоединиться к бюджету.
        const code = newInviteCode();
        const ts = nowIso();
        await db.run(
          `INSERT INTO budget_invites (id, budget_id, code_hash, role, created_by, expires_at,
                                       max_uses, uses, created_at)
           VALUES (?,?,?,?,?,?,1,0,?)`,
          newId(), member.budgetId, hashCode(code), input.role, req.userId,
          new Date(Date.now() + input.expiresInHours * 3600_000).toISOString(), ts,
        );
        return { code, role: input.role, expiresInHours: input.expiresInHours };
      },
      201,
    );
  });

  app.post('/invites/accept', async (req, reply) => {
    const input = parseBody(acceptInviteSchema, req.body);
    return idempotent(req, reply, () =>
      mutate(req.userId, async (emit) => {
        // Право доступа к приглашению даёт знание кода, а не членство:
        // принимающий участником ещё не является, и проверка по членству
        // отвергла бы его. Хеш кладётся в переменную транзакции, и политика
        // делает видимой ровно одну строку — ту, чей хеш уже известен.
        await db.setLocal('app.invite_code_hash', hashCode(input.code));

        const invite = await db.get<{
          id: string; budget_id: string; role: Role; expires_at: string;
          max_uses: number; uses: number; revoked_at: string | null;
        }>('SELECT * FROM budget_invites WHERE code_hash = ?', hashCode(input.code));

        if (!invite) throw notFound('Приглашение не найдено');
        if (invite.revoked_at) throw unprocessable('invite_revoked', 'Приглашение отозвано');
        if (invite.expires_at < nowIso()) throw unprocessable('invite_expired', 'Срок приглашения истёк');
        if (invite.uses >= invite.max_uses) {
          throw unprocessable('invite_used', 'Приглашение уже использовано');
        }

        const existing = await db.get(
          'SELECT 1 FROM budget_members WHERE budget_id = ? AND user_id = ?',
          invite.budget_id, req.userId,
        );
        if (existing) return { budgetId: invite.budget_id, alreadyMember: true };

        const ts = nowIso();
        await db.run(
          'INSERT INTO budget_members (budget_id, user_id, role, invited_by, joined_at) VALUES (?,?,?,?,?)',
          invite.budget_id, req.userId, invite.role, null, ts,
        );
        await db.run('UPDATE budget_invites SET uses = uses + 1 WHERE id = ?', invite.id);

        await emit({
          budgetId: invite.budget_id, entity: 'member', entityId: req.userId,
          op: 'insert', actorId: req.userId, payload: { members: await listMembers(invite.budget_id) },
        });
        return { budgetId: invite.budget_id, role: invite.role, alreadyMember: false };
      }),
    );
  });

  app.patch<{ Params: { budgetId: string; userId: string } }>(
    '/budgets/:budgetId/members/:userId',
    async (req, reply) => {
      const member = await requireMember(req.userId, req.params.budgetId, 'owner');
      const input = parseBody(updateMemberSchema, req.body);
      const targetId = req.params.userId;
      return idempotent(req, reply, () =>
        mutate(req.userId, async (emit) => {
          if (targetId === req.userId) {
            throw forbidden('Владелец не может изменить собственную роль');
          }
          const { changes } = await db.run(
            `UPDATE budget_members SET role = ? WHERE budget_id = ? AND user_id = ? AND role <> 'owner'`,
            input.role, member.budgetId, targetId,
          );
          if (changes === 0) throw notFound('Участник не найден');
          await emit({
            budgetId: member.budgetId, entity: 'member', entityId: targetId,
            op: 'update', actorId: req.userId, payload: { members: await listMembers(member.budgetId) },
          });
          return { ok: true };
        }),
      );
    },
  );

  app.delete<{ Params: { budgetId: string; userId: string } }>(
    '/budgets/:budgetId/members/:userId',
    async (req, reply) => {
      const member = await requireMember(req.userId, req.params.budgetId, 'owner');
      const targetId = req.params.userId;
      return idempotent(req, reply, () =>
        mutate(req.userId, async (emit) => {
          if (targetId === req.userId) {
            throw forbidden('Владелец не может исключить сам себя — сначала передайте бюджет');
          }
          const { changes } = await db.run(
            `DELETE FROM budget_members WHERE budget_id = ? AND user_id = ? AND role <> 'owner'`,
            member.budgetId, targetId,
          );
          if (changes === 0) throw notFound('Участник не найден');
          // Событие важно не только для UI: hub по нему принудительно закрывает
          // realtime-подписки исключённого пользователя.
          await emit({
            budgetId: member.budgetId, entity: 'member', entityId: targetId,
            op: 'delete', actorId: req.userId,
            payload: { removedUserId: targetId, members: await listMembers(member.budgetId) },
          });
          return { ok: true };
        }),
      );
    },
  );
};
