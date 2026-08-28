import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Контекст запроса.
 *
 * Идентификатор устройства нужен журналу событий, но протаскивать его
 * параметром через каждый сервисный вызов — шум. AsyncLocalStorage даёт
 * request-scoped значение без глобальной изменяемой переменной, которая
 * ломалась бы при конкурентных запросах.
 */
export interface RequestContext {
  clientId: string | null;
  /**
   * Пользователь запроса. Заполняется после проверки токена и нужен
   * Postgres для `SET LOCAL app.user_id`: без него RLS-политики
   * не пропустят ни одной строки — даже на чтение.
   */
  userId: string | null;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export const currentClientId = (): string | null =>
  requestContext.getStore()?.clientId ?? null;

export const currentUserId = (): string | null =>
  requestContext.getStore()?.userId ?? null;

export function setCurrentUserId(userId: string): void {
  const store = requestContext.getStore();
  if (store) store.userId = userId;
}
