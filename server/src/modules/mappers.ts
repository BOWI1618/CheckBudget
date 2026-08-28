/**
 * Преобразование строк БД в DTO.
 *
 * Все денежные поля сериализуются в СТРОКИ. Это защищает от единственной
 * по-настоящему опасной ошибки в финансовом приложении: попадания суммы
 * в число с плавающей точкой на каком-нибудь клиенте. Строка не может
 * «случайно» стать float ни в одном языке.
 */
export const m = (n: number | null | undefined): string | null =>
  n === null || n === undefined ? null : String(n);

export const bool = (n: unknown): boolean => n === 1 || n === true;

export interface AccountRow {
  id: string; budget_id: string; name: string; type: string; currency: string;
  initial_balance_minor: number; balance_minor: number; color: string; icon: string;
  is_archived: number; sort_order: number; version: number; updated_at: string;
}

export const toAccount = (r: AccountRow) => ({
  id: r.id,
  budgetId: r.budget_id,
  name: r.name,
  type: r.type,
  currency: r.currency,
  initialBalanceMinor: m(r.initial_balance_minor),
  balanceMinor: m(r.balance_minor),
  color: r.color,
  icon: r.icon,
  isArchived: bool(r.is_archived),
  sortOrder: r.sort_order,
  version: r.version,
  updatedAt: r.updated_at,
});

export interface CategoryRow {
  id: string; budget_id: string; parent_id: string | null; name: string; kind: string;
  icon: string; color: string; is_system: number; sort_order: number;
  version: number; updated_at: string;
}

export const toCategory = (r: CategoryRow) => ({
  id: r.id,
  budgetId: r.budget_id,
  parentId: r.parent_id,
  name: r.name,
  kind: r.kind,
  icon: r.icon,
  color: r.color,
  isSystem: bool(r.is_system),
  sortOrder: r.sort_order,
  version: r.version,
  updatedAt: r.updated_at,
});

export interface TransactionRow {
  id: string; budget_id: string; type: string; account_id: string;
  counter_account_id: string | null; category_id: string | null;
  amount_minor: number; currency: string;
  base_amount_minor: number | null; base_currency: string;
  rate_num: number | null; rate_den: number | null;
  rate_date: string | null; rate_source: string | null;
  counter_amount_minor: number | null; counter_currency: string | null;
  occurred_on: string; note: string | null;
  created_by: string; updated_by: string;
  created_at: string; updated_at: string; version: number; deleted_at: string | null;
}

export const toTransaction = (r: TransactionRow) => ({
  id: r.id,
  budgetId: r.budget_id,
  type: r.type,
  accountId: r.account_id,
  counterAccountId: r.counter_account_id,
  categoryId: r.category_id,
  amountMinor: m(r.amount_minor),
  currency: r.currency,
  baseAmountMinor: m(r.base_amount_minor),
  baseCurrency: r.base_currency,
  rateNum: r.rate_num,
  rateDen: r.rate_den,
  rateDate: r.rate_date,
  rateSource: r.rate_source,
  counterAmountMinor: m(r.counter_amount_minor),
  counterCurrency: r.counter_currency,
  occurredOn: r.occurred_on,
  note: r.note,
  createdBy: r.created_by,
  updatedBy: r.updated_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
  deletedAt: r.deleted_at,
});

export interface LimitRow {
  id: string; budget_id: string; category_id: string; period: string;
  limit_minor: number; currency: string; version: number;
}

export const toLimit = (r: LimitRow) => ({
  id: r.id,
  budgetId: r.budget_id,
  categoryId: r.category_id,
  period: r.period,
  limitMinor: m(r.limit_minor),
  currency: r.currency,
  version: r.version,
});

export interface GoalRow {
  id: string; budget_id: string; name: string; target_minor: number; saved_minor: number;
  currency: string; due_on: string | null; icon: string; color: string; version: number;
}

export const toGoal = (r: GoalRow) => ({
  id: r.id,
  budgetId: r.budget_id,
  name: r.name,
  targetMinor: m(r.target_minor),
  savedMinor: m(r.saved_minor),
  currency: r.currency,
  dueOn: r.due_on,
  icon: r.icon,
  color: r.color,
  version: r.version,
});
