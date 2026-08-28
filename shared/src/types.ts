export type Role = 'owner' | 'editor' | 'viewer';
export type AccountType = 'cash' | 'card' | 'bank' | 'ewallet' | 'savings';
export type CategoryKind = 'expense' | 'income';
export type TransactionType = 'expense' | 'income' | 'transfer';
export type EntityType =
  | 'transaction' | 'category' | 'account' | 'limit' | 'goal' | 'budget' | 'member';
export type EventOp = 'insert' | 'update' | 'delete';

export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface UserSettings {
  baseCurrency: string;
  displayCurrency: string | null;
  locale: string;
  theme: 'light' | 'dark' | 'system';
  defaultBudgetId: string | null;
}

export interface Budget {
  id: string;
  name: string;
  baseCurrency: string;
  ownerId: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface Member {
  userId: string;
  displayName: string;
  email: string;
  role: Role;
  joinedAt: string;
}

export interface Account {
  id: string;
  budgetId: string;
  name: string;
  type: AccountType;
  currency: string;
  /** Начальный остаток в минорных единицах валюты счёта. */
  initialBalanceMinor: number;
  /** Вычисляемое поле: initialBalance + сумма операций. Не хранится в БД. */
  balanceMinor: number;
  color: string;
  icon: string;
  isArchived: boolean;
  sortOrder: number;
  version: number;
  updatedAt: string;
}

export interface Category {
  id: string;
  budgetId: string;
  parentId: string | null;
  name: string;
  kind: CategoryKind;
  icon: string;
  color: string;
  isSystem: boolean;
  sortOrder: number;
  version: number;
  updatedAt: string;
}

export interface Transaction {
  id: string;
  budgetId: string;
  type: TransactionType;
  accountId: string;
  counterAccountId: string | null;
  categoryId: string | null;
  /** Исходная сумма — неизменяемый факт. Всегда положительная. */
  amountMinor: number;
  currency: string;
  /** Сумма в базовой валюте бюджета, зафиксированная в момент записи. */
  baseAmountMinor: number | null;
  baseCurrency: string;
  /** Курс, применённый при конвертации. Замораживается вместе с операцией. */
  rateNum: number | null;
  rateDen: number | null;
  rateDate: string | null;
  rateSource: string | null;
  /** Сумма, зачисленная на счёт назначения (только для переводов). */
  counterAmountMinor: number | null;
  counterCurrency: string | null;
  /** Календарная дата операции, YYYY-MM-DD. Не timestamp — чтобы не «уезжала» по TZ. */
  occurredOn: string;
  note: string | null;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
}

export interface BudgetLimit {
  id: string;
  budgetId: string;
  categoryId: string;
  /** Месяц в формате YYYY-MM. */
  period: string;
  limitMinor: number;
  currency: string;
  version: number;
}

export interface Goal {
  id: string;
  budgetId: string;
  name: string;
  targetMinor: number;
  savedMinor: number;
  currency: string;
  dueOn: string | null;
  icon: string;
  color: string;
  version: number;
}

export interface SyncEvent {
  seq: number;
  budgetId: string;
  entity: EntityType;
  entityId: string;
  op: EventOp;
  actorId: string;
  /** Устройство, породившее изменение. Позволяет отличить свой отклик от чужого. */
  actorClientId: string | null;
  actorName: string;
  payload: unknown;
  createdAt: string;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Тело ответа 409: сервер всегда возвращает актуальное состояние объекта. */
export interface VersionConflict<T = unknown> {
  error: {
    code: 'version_conflict';
    message: string;
    current: T;
  };
}
