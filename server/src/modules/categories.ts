import type { FastifyInstance } from 'fastify';
import { createCategorySchema, updateCategorySchema, deleteSchema } from '@checkbudget/shared';
import { db } from '../db/index.js';
import { mutate } from '../core/events.js';
import { requireMember } from '../core/permissions.js';
import { notFound, unprocessable, VersionConflictError } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { requireAuth, parseBody, idempotent } from '../http/helpers.js';
import { toCategory, type CategoryRow } from './mappers.js';

export function listCategories(budgetId: string): CategoryRow[] {
  return db.all<CategoryRow>(
    `SELECT * FROM categories WHERE budget_id = ? AND deleted_at IS NULL
      ORDER BY kind, sort_order, name`,
    budgetId,
  );
}

function findCategory(budgetId: string, id: string): CategoryRow {
  const row = db.get<CategoryRow>(
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
function validateParent(budgetId: string, parentId: string | null, kind: string, selfId?: string) {
  if (!parentId) return;
  if (parentId === selfId) throw unprocessable('self_parent', 'Категория не может быть вложена в себя');
  const parent = findCategory(budgetId, parentId);
  if (parent.kind !== kind) {
    throw unprocessable('kind_mismatch', 'Родительская категория другого типа');
  }
  if (parent.parent_id) {
    throw unprocessable('too_deep', 'Поддерживается только два уровня вложенности');
  }
  if (selfId) {
    const hasChildren = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM categories WHERE parent_id = ? AND deleted_at IS NULL',
      selfId,
    )?.n ?? 0;
    if (hasChildren > 0) {
      throw unprocessable('has_children', 'У категории есть подкатегории — её нельзя вложить');
    }
  }
}

export const categoryRoutes = async (app: FastifyInstance): Promise<void> => {
  app.addHook('preHandler', requireAuth);

  app.get<{ Params: { budgetId: string } }>('/budgets/:budgetId/categories', async (req) => {
    const member = requireMember(req.userId, req.params.budgetId);
    return { items: listCategories(member.budgetId).map(toCategory) };
  });

  app.post<{ Params: { budgetId: string } }>('/budgets/:budgetId/categories', async (req, reply) => {
    const member = requireMember(req.userId, req.params.budgetId, 'editor');
    const input = parseBody(createCategorySchema, req.body);
    return idempotent(
      req,
      reply,
      () =>
        mutate((emit) => {
          validateParent(member.budgetId, input.parentId, input.kind);
          const id = newId();
          const ts = nowIso();
          const maxOrder = db.get<{ n: number | null }>(
            'SELECT MAX(sort_order) AS n FROM categories WHERE budget_id = ? AND kind = ?',
            member.budgetId, input.kind,
          )?.n ?? 0;
          db.run(
            `INSERT INTO categories (id, budget_id, parent_id, name, kind, icon, color,
                                     sort_order, created_at, updated_at, version)
             VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
            id, member.budgetId, input.parentId, input.name, input.kind,
            input.icon, input.color, maxOrder + 1, ts, ts,
          );
          const row = findCategory(member.budgetId, id);
          emit({
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
      const member = requireMember(req.userId, req.params.budgetId, 'editor');
      const input = parseBody(updateCategorySchema, req.body);
      const { id } = req.params;
      return idempotent(req, reply, () =>
        mutate((emit) => {
          const current = findCategory(member.budgetId, id);
          if (current.version !== input.version) throw new VersionConflictError(toCategory(current));
          const parentId = input.parentId !== undefined ? input.parentId : current.parent_id;
          validateParent(member.budgetId, parentId, current.kind, id);
          const ts = nowIso();
          const { changes } = db.run(
            `UPDATE categories SET name = ?, parent_id = ?, icon = ?, color = ?,
                                   updated_at = ?, version = version + 1
              WHERE budget_id = ? AND id = ? AND version = ?`,
            input.name ?? current.name, parentId,
            input.icon ?? current.icon, input.color ?? current.color,
            ts, member.budgetId, id, input.version,
          );
          if (changes === 0) throw new VersionConflictError(toCategory(findCategory(member.budgetId, id)));
          const row = findCategory(member.budgetId, id);
          emit({
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
      const member = requireMember(req.userId, req.params.budgetId, 'editor');
      const { version } = parseBody(deleteSchema, req.body);
      const { id } = req.params;
      return idempotent(req, reply, () =>
        mutate((emit) => {
          const current = findCategory(member.budgetId, id);
          if (current.version !== version) throw new VersionConflictError(toCategory(current));

          const used = db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM transactions WHERE budget_id = ? AND category_id = ? AND deleted_at IS NULL',
            member.budgetId, id,
          )?.n ?? 0;
          if (used > 0) {
            throw unprocessable('category_in_use', `В категории ${used} операц. — сначала перенесите их`);
          }
          const children = db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM categories WHERE parent_id = ? AND deleted_at IS NULL',
            id,
          )?.n ?? 0;
          if (children > 0) {
            throw unprocessable('has_children', 'Сначала удалите подкатегории');
          }

          const ts = nowIso();
          db.run(
            `UPDATE categories SET deleted_at = ?, updated_at = ?, version = version + 1
              WHERE budget_id = ? AND id = ? AND version = ?`,
            ts, ts, member.budgetId, id, version,
          );
          emit({
            budgetId: member.budgetId, entity: 'category', entityId: id,
            op: 'delete', actorId: member.userId, payload: { id, version: version + 1 },
          });
          return { ok: true };
        }),
      );
    },
  );
};
