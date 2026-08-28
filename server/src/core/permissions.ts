import type { Role } from '@checkbudget/shared';
import { db } from '../db/index.js';
import { forbidden, notFound } from './errors.js';

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export interface Membership {
  budgetId: string;
  userId: string;
  role: Role;
  baseCurrency: string;
  budgetName: string;
}

/**
 * Единственная дверь к данным бюджета.
 *
 * Любой маршрут /budgets/:budgetId/* обязан пройти через неё. Если членства нет —
 * возвращается 404, а не 403: иначе перебором budgetId можно было бы узнать,
 * какие бюджеты существуют в системе.
 */
export function requireMember(userId: string, budgetId: string, minRole: Role = 'viewer'): Membership {
  const row = db.get<{ role: Role; base_currency: string; name: string }>(
    `SELECT m.role, b.base_currency, b.name
       FROM budget_members m
       JOIN budgets b ON b.id = m.budget_id
      WHERE m.budget_id = ? AND m.user_id = ? AND b.archived_at IS NULL`,
    budgetId,
    userId,
  );
  if (!row) throw notFound('Бюджет не найден');
  if (RANK[row.role] < RANK[minRole]) {
    throw forbidden(
      minRole === 'owner'
        ? 'Действие доступно только владельцу бюджета'
        : 'У вас права только на просмотр',
    );
  }
  return {
    budgetId,
    userId,
    role: row.role,
    baseCurrency: row.base_currency,
    budgetName: row.name,
  };
}

export const isAtLeast = (role: Role, min: Role): boolean => RANK[role] >= RANK[min];
