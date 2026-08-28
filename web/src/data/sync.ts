import type { SyncEvent } from '@checkbudget/shared';
import { getAccessToken, api } from './api.js';
import { store } from './store.js';

/**
 * Realtime-канал.
 *
 * Ключевая идея — не «подписка на изменения», а «курсор в журнале событий».
 * Клиент всегда знает свой seq, поэтому переподключение после метро, сна
 * ноутбука или смены Wi-Fi стоит одну догрузку хвоста, а не перезагрузку
 * всех данных.
 */

const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 30_000;
const HEARTBEAT_MS = 25_000;

let socket: WebSocket | null = null;
let budgetId: string | null = null;
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let closedByUs = false;

const wsUrl = (): string => {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
};

function clearTimers(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function scheduleReconnect(): void {
  if (closedByUs || reconnectTimer) return;
  // Экспоненциальный backoff с джиттером: без джиттера все клиенты
  // переподключаются одновременно и добивают только что поднявшийся сервер.
  const base = Math.min(RECONNECT_MIN * 2 ** attempt, RECONNECT_MAX);
  const delay = base / 2 + Math.random() * (base / 2);
  attempt++;

  // Короткий разрыв (смена сети, пробуждение вкладки) — это «подключение…».
  // Но если восстановиться не удалось с первой попытки, честнее сказать
  // «нет соединения»: иначе индикатор навсегда застревает в оптимистичном
  // состоянии и пользователь не понимает, почему ничего не приходит.
  store.setConnection(attempt <= 1 ? 'connecting' : 'offline');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function send(message: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function subscribe(): void {
  if (!budgetId) return;
  const seq = store.getState().data?.seq;
  send({ type: 'subscribe', budgetId, sinceSeq: typeof seq === 'number' ? seq : undefined });
}

function connect(): void {
  if (!budgetId || socket) return;
  // Токена может ещё не быть — например, приложение поднялось из локального
  // кеша без сети. Это не повод прекращать попытки: как только сессия
  // восстановится, следующая попытка подключения пройдёт.
  if (!getAccessToken()) return scheduleReconnect();

  closedByUs = false;
  const ws = new WebSocket(wsUrl());
  socket = ws;

  ws.onopen = () => {
    send({ type: 'auth', token: getAccessToken() });
    heartbeatTimer = setInterval(() => send({ type: 'ping' }), HEARTBEAT_MS);
  };

  ws.onmessage = (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'auth.ok':
        attempt = 0;
        subscribe();
        break;

      case 'subscribed': {
        store.setConnection('online');
        const events = (msg.events ?? []) as SyncEvent[];
        // Догруженный хвост применяется строго по возрастанию seq.
        for (const event of events) store.applyEvent(reviveEvent(event));
        break;
      }

      case 'resync':
        // Разрыв слишком велик — дешевле перечитать снимок целиком.
        if (budgetId) void store.refreshSnapshot(budgetId);
        store.setConnection('online');
        break;

      case 'event':
        store.applyEvent(reviveEvent(msg as unknown as SyncEvent));
        break;

      case 'unsubscribed':
        if (msg.reason === 'access_revoked') {
          store.toast('error', 'Ваш доступ к бюджету отозван');
        }
        break;

      case 'error':
        if (msg.code === 'unauthorized') {
          // Токен протух за время жизни соединения: обновляем и авторизуемся заново.
          void api.refresh().then((result) => {
            if (result === 'ok') send({ type: 'auth', token: getAccessToken() });
          });
        }
        break;
    }
  };

  ws.onclose = () => {
    socket = null;
    clearTimers();
    if (!closedByUs) {
      store.setConnection('offline');
      scheduleReconnect();
    }
  };

  ws.onerror = () => ws.close();
}

/**
 * Суммы в payload события приходят строками — тем же контрактом, что и в REST.
 * Приводим их к числам ровно один раз, здесь.
 */
function reviveEvent(event: SyncEvent): SyncEvent {
  const payload = event.payload as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object') return event;
  const revived: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    revived[key] = key.endsWith('Minor') && typeof value === 'string' ? Number(value) : value;
  }
  return { ...event, payload: revived };
}

export function startSync(nextBudgetId: string): void {
  if (budgetId === nextBudgetId && socket) return subscribe();
  budgetId = nextBudgetId;
  if (socket) {
    closedByUs = true;
    socket.close();
    socket = null;
  }
  closedByUs = false;
  clearTimers();
  attempt = 0;
  connect();
}

export function stopSync(): void {
  closedByUs = true;
  budgetId = null;
  clearTimers();
  socket?.close();
  socket = null;
}

/**
 * Браузерные сигналы — только подсказки, а не источник истины:
 * navigator.onLine возвращает true и в Wi-Fi без интернета.
 * Реальным признаком связи считается результат запроса.
 */
export function installConnectivityWatchers(): void {
  addEventListener('online', () => {
    attempt = 0;
    connect();
    void store.flushQueue();
  });
  addEventListener('offline', () => store.setConnection('offline'));

  // Возврат на вкладку после сна устройства — самый частый случай,
  // когда сокет «жив» по мнению браузера, но мёртв по факту.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!socket) connect();
      else subscribe();
      void store.flushQueue();
    }
  });
}
