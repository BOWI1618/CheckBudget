import type { FastifyInstance } from 'fastify';
import { createCategorySchema, updateCategorySchema, deleteSchema } from '@checkbudget/shared';
import { db } from '../db/index.js';
import { mutate } from '../core/events.js';
import { requireMember } from '../core/permissions.js';
import { notFound, unprocessable, VersionConflictError } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { requireAuth, parseBody, idempotent } from '../http/helpers.js';
import { toCategory, type CategoryRow } from './mappers.js';

export async function listCategories(budgetId: string): Promise<CategoryRow[]> {
  return await db.all<CategoryRow>(
    `SELECT * FROM categories WHERE budget_id = ? AND deleted_at IS NULL
      ORDER BY kind, sort_order, name`,
    budgetId,
  );
}

async function findCategory(budgetId: string, id: string): Promise<CategoryRow> {
  const row = await db.get<CategoryRow>(
    'SELECT * FROM categories WHERE budget_id = ? AND id = ? AND deleted_at IS NULL',
    budgetId,
    id,
  );
  if (!row) throw notFound('Категория не найдена');
  return row;
}

/**
 * Иерархия ограничена двумя уровнями (Еда → Продукты).
 *
 * Это не техническое ограничение, а продуктовое решение: третий уровень
 * усложняет выбор при вводе операции — а быстрый ввод здесь важнее гибкости.
 * Схема (parent_id → categories.id) при этом произвольной глубины,
 * так что снять ограничение можно без миграции.
 */
async function validateParent(budgetId: string, parentId: string | null, kind: string, selfId?: string) {
  if (!parentId) return;
  if (parentId === selfId) throw unprocessable('self_parent', 'Категория не может быть вложена в себя');
  const parent = await findCategory(budgetId, parentId);
  if (parent.kind !== kind) {
    throw unprocessable('kind_mismatch', 'Родительская категория другого типа');
  }
  if (parent.parent_id) {
    throw unprocessable('too_deep', 'Поддерживается только два уровня вложенности');
  }
  if (selfId) {
    const hasChildren = (await db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM categories WHERE parent_id = ? AND deleted_at IS NULL',
      selfId,
    ))?.n ?? 0;
    if (hasChildren > 0) {
      throw unprocessable('has_children', 'У категории есть подкатегории — её нельзя вложить');
    }
  }
}

export const categoryRoutes = async (app: FastifyInstance): Promise<void> => {
  app.addHook('preHandler', requireAuth);

  app.get<{ Params: { budgetId: string } }>('/budgets/:budgetId/categories', async (req) => {
    const member = await requireMember(req.userId, req.params.budgetId);
    return { items: (await listCategories(member.budgetId)).map(toCategory) };
  });

  app.post<{ Params: { budgetId: string } }>('/budgets/:budgetId/categories', async (req, reply) => {
    const member = await requireMember(req.userId, req.params.budgetId, 'editor');
    const input = parseBody(createCategorySchema, req.body);
    return idempotent(
      req,
      reply,
      () =>
        mutate(member.userId, async (emit) => {
          await validateParent(member.budgetId, input.parentId, input.kind);
          const id = newId();
          const ts = nowIso();
          const maxOrder = (await db.get<{ n: number | null }>(
            'SELECT MAX(sort_order) AS n FROM categories WHERE budget_id = ? AND kind = ?',
            member.budgetId, input.kind,
          ))?.n ?? 0;
          await db.run(
            `INSERT INTO categories (id, budget_id, parent_id, name, kind, icon, color,
                                     sort_order, created_at, updated_at, version)
             VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
            id, member.budgetId, input.parentId, input.name, input.kind,
            input.icon, input.color, maxOrder + 1, ts, ts,
          );
          const row = await findCategory(member.budgetId, id);
          await emit({
            budgetId: member.budgetId, entity: 'category', entityId: id,
            op: 'insert', actorId: member.userId, payload: toCategory(row),
          });
          return toCategory(row);
        }),
      201,
    );
  });

  app.patch<{ Params: { budgetId: string; id: string } }>(
    '/budgets/:budgetId/categories/:id',
    async (req, reply) => {
      const member = await requireMember(req.userId, req.params.budgetId, 'editor');
      const input = parseBody(updateCategorySchema, req.body);
      const { id } = req.params;
      return idempotent(req, reply, () =>
        mutate(member.userId, async (emit) => {
          const current = await findCategory(member.budgetId, id);
          if (current.version !== input.version) throw new VersionConflictError(toCategory(current));
          const parentId = input.parentId !== undefined ? input.parentId : current.parent_id;
          await validateParent(member.budgetId, parentId, current.kind, id);
          const ts = nowIso();
          const { changes } = await db.run(
            `UPDATE categories SET name = ?, parent_id = ?, icon = ?, color = ?,
                                   updated_at = ?, version = version + 1
              WHERE budget_id = ? AND id = ? AND version = ?`,
            input.name ?? current.name, parentId,
            input.icon ?? current.icon, input.color ?? current.color,
            ts, member.budgetId, id, input.version,
          );
          if (changes === 0) throw new VersionConflictError(toCategory(await findCategory(member.budgetId, id)));
          const row = await findCategory(member.budgetId, id);
          await emit({
            budgetId: member.budgetId, entity: 'category', entityId: id,
            op: 'update', actorId: member.userId, payload: toCategory(row),
          });
          return toCategory(row);
        }),
      );
    },
  );

  app.delete<{ Params: { budgetId: string; id: string } }>(
    '/budgets/:budgetId/categories/:id',
    async (req, reply) => {
      const member = await requireMember(req.userId, req.params.budgetId, 'editor');
      const { version } = parseBody(deleteSchema, req.body);
      const { id } = req.params;
      return idempotent(req, reply, () =>
        mutate(member.userId, async (emit) => {
          const current = await findCategory(member.budgetId, id);
          if (current.version !== version) throw new VersionConflictError(toCategory(current));

          const used = (await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM transactions WHERE budget_id = ? AND category_id = ? AND deleted_at IS NULL',
            member.budgetId, id,
          ))?.n ?? 0;
          if (used > 0) {
            throw unprocessable('category_in_use', `В категории ${used} операц. — сначала перенесите их`);
          }
          const children = (await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM categories WHERE parent_id = ? AND deleted_at IS NULL',
            id,
          ))?.n ?? 0;
          if (children > 0) {
            throw unprocessable('has_children', 'Сначала удалите подкатегории');
          }

          const ts = nowIso();
          await db.run(
            `UPDATE categories SET deleted_at = ?, updated_at = ?, version = version + 1
              WHERE budget_id = ? AND id = ? AND version = ?`,
            ts, ts, member.budgetId, id, version,
          );
          await emit({
            budgetId: member.budgetId, entity: 'category', entityId: id,
            op: 'delete', actorId: member.userId, payload: { id, version: version + 1 },
          });
          return { ok: true };
        }),
      );
    },
  );
};
