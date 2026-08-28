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
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export const currentClientId = (): string | null =>
  requestContext.getStore()?.clientId ?? null;
