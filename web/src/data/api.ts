/**
 * HTTP-клиент.
 *
 * Отвечает за три вещи, которые нельзя размазывать по компонентам:
 *   1. Обновление access-токена по 401 — прозрачно, с дедупликацией.
 *   2. Обратное преобразование денежных полей из строк в числа.
 *   3. Типизированные ошибки, включая 409 с актуальным состоянием объекта.
 */

const API = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly current?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Сеть недоступна — операция не отвергнута сервером, её можно повторить. */
export class NetworkError extends Error {
  constructor() {
    super('Нет соединения с сервером');
    this.name = 'NetworkError';
  }
}

/**
 * Сервер отдаёт денежные суммы строками, чтобы они гарантированно не прошли
 * через float ни на одном клиенте. Здесь они однократно превращаются в целые
 * числа минорных единиц — единственное представление, с которым работает UI.
 */
function reviveMoney<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reviveMoney) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (key.endsWith('Minor') && typeof v === 'string') {
        const n = Number(v);
        if (!Number.isSafeInteger(n)) throw new Error(`Некорректная сумма в ответе: ${key}=${v}`);
        out[key] = n;
      } else {
        out[key] = reviveMoney(v);
      }
    }
    return out as T;
  }
  return value;
}

/**
 * Идентификатор устройства (вкладки).
 *
 * Нужен, чтобы отличать собственный отклик от изменения, пришедшего с другого
 * устройства — в том числе другого устройства ТОГО ЖЕ пользователя. Именно этот
 * случай («телефон и компьютер одного человека») — основной сценарий продукта,
 * и сравнение по userId его не покрывает.
 *
 * sessionStorage, а не localStorage: две вкладки — это два независимых
 * «устройства», и они должны видеть изменения друг друга.
 */
function readClientId(): string {
  try {
    const existing = sessionStorage.getItem('cb_client_id');
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem('cb_client_id', created);
    return created;
  } catch {
    return crypto.randomUUID(); // приватный режим — идентификатор живёт в памяти
  }
}

export const CLIENT_ID = readClientId();

let accessToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export const setAccessToken = (token: string | null): void => { accessToken = token; };
export const getAccessToken = (): string | null => accessToken;
export const setUnauthorizedHandler = (fn: () => void): void => { onUnauthorized = fn; };

/**
 * Результат обновления сессии.
 *
 * Различать «сервер сказал, что сессии нет» и «сервер недоступен» обязательно:
 * в первом случае нужен экран входа, во втором — работа по локальному кешу.
 * Если их смешать, приложение будет выкидывать на логин при каждом выходе
 * из метро, теряя весь смысл офлайн-режима.
 */
export type RefreshResult = 'ok' | 'unauthorized' | 'offline';

/** Один параллельный refresh на всё приложение — иначе гонка ротации токенов. */
let refreshing: Promise<RefreshResult> | null = null;

async function refreshAccessToken(): Promise<RefreshResult> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${API}/auth/refresh`, { method: 'POST', credentials: 'include' });
        // Только 401/403 означают «сессии нет». Всё остальное (502 от шлюза,
        // 503 при деплое, 504 по таймауту) — недоступность сервера, и выкидывать
        // из-за неё на экран входа нельзя: локальные данные никуда не делись.
        if (res.status === 401 || res.status === 403) return 'unauthorized';
        if (!res.ok) return 'offline';
        const data = await res.json();
        accessToken = data.accessToken;
        return 'ok';
      } catch {
        return 'offline';
      } finally {
        // Сбрасываем в микрозадаче, чтобы конкурентные вызовы успели
        // подхватить один и тот же промис.
        queueMicrotask(() => { refreshing = null; });
      }
    })();
  }
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Внутренний флаг: не пытаться обновлять токен второй раз. */
  retried?: boolean;
}

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  headers['x-client-id'] = CLIENT_ID;

  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (method !== 'GET') {
    headers['idempotency-key'] = opts.idempotencyKey ?? crypto.randomUUID();
  }

  let res: Response;
  try {
    res = await fetch(API + path, {
      method,
      headers,
      credentials: 'include',
      signal: opts.signal ?? null,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new NetworkError();
  }

  // Обновлять токен по 401 имеет смысл только для обычных запросов.
  // Для /auth/* это вредно: неверный пароль превратился бы в «Требуется вход»,
  // и пользователь не понял бы, что именно он ввёл не так.
  const isAuthEndpoint = path.startsWith('/auth/');
  if (res.status === 401 && !opts.retried && !isAuthEndpoint) {
    const result = await refreshAccessToken();
    if (result === 'ok') return request<T>(path, { ...opts, retried: true });
    if (result === 'offline') throw new NetworkError();
    onUnauthorized?.();
    throw new ApiError(401, 'unauthorized', 'Требуется вход');
  }

  if (res.status === 204) return null as T;

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const error = data?.error;

    // Недоступность инфраструктуры — не отказ приложения.
    //
    // Ответ мог прийти не от нашего сервера, а от прокси или балансировщика
    // (502/503/504, или 500 от dev-прокси при упавшем бэкенде). Такие ответы
    // не несут наш конверт `{ error: { code } }` и означают «повтори позже»,
    // а не «запрос отвергнут». Разница принципиальна: от неё зависит,
    // останется мутация в офлайн-очереди или будет молча отброшена.
    const isGatewayFailure =
      res.status === 408 || res.status === 502 || res.status === 503 || res.status === 504 ||
      (res.status >= 500 && !error?.code);
    if (isGatewayFailure) throw new NetworkError();

    throw new ApiError(
      res.status,
      error?.code ?? 'unknown',
      error?.message ?? 'Ошибка запроса',
      error?.details,
      error?.current ? reviveMoney(error.current) : undefined,
    );
  }

  return reviveMoney(data) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown, idempotencyKey?: string) =>
    request<T>(path, { method: 'POST', body, idempotencyKey }),
  patch: <T>(path: string, body?: unknown, idempotencyKey?: string) =>
    request<T>(path, { method: 'PATCH', body, idempotencyKey }),
  put: <T>(path: string, body?: unknown, idempotencyKey?: string) =>
    request<T>(path, { method: 'PUT', body, idempotencyKey }),
  del: <T>(path: string, body?: unknown, idempotencyKey?: string) =>
    request<T>(path, { method: 'DELETE', body, idempotencyKey }),
  refresh: refreshAccessToken,
};
