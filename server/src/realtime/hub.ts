import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { SyncEvent } from '@checkbudget/shared';
import { verifyAccessToken } from '../auth/tokens.js';
import { readEventsSince, countEventsSince, currentSeq, setBroadcaster } from '../core/events.js';
import { db } from '../db/index.js';
import { config } from '../config.js';

let wss: WebSocketServer | null = null;

interface Client {
  socket: WebSocket;
  userId: string | null;
  /** budgetId -> подписка. Один сокет может слушать несколько бюджетов. */
  budgets: Set<string>;
  alive: boolean;
}

const clients = new Set<Client>();
/** Индекс по бюджету: рассылка не обходит всех клиентов подряд. */
const byBudget = new Map<string, Set<Client>>();

const send = (client: Client, message: unknown): void => {
  if (client.socket.readyState === WebSocket.OPEN) {
    client.socket.send(JSON.stringify(message));
  }
};

function subscribe(client: Client, budgetId: string): void {
  client.budgets.add(budgetId);
  let set = byBudget.get(budgetId);
  if (!set) byBudget.set(budgetId, (set = new Set()));
  set.add(client);
}

function unsubscribe(client: Client, budgetId: string): void {
  client.budgets.delete(budgetId);
  const set = byBudget.get(budgetId);
  if (set) {
    set.delete(client);
    if (set.size === 0) byBudget.delete(budgetId);
  }
}

function detach(client: Client): void {
  for (const budgetId of [...client.budgets]) unsubscribe(client, budgetId);
  clients.delete(client);
}

/** Членство проверяется на момент подписки, а не на момент коннекта. */
async function isMember(userId: string, budgetId: string): Promise<boolean> {
  return !!(await db.get(
    `SELECT 1 FROM budget_members m JOIN budgets b ON b.id = m.budget_id
      WHERE m.budget_id = ? AND m.user_id = ? AND b.archived_at IS NULL`,
    budgetId, userId,
  ));
}

/**
 * Принудительный разрыв подписки при отзыве доступа.
 *
 * Без этого исключённый участник продолжал бы получать события бюджета,
 * пока не переподключится — подписка живёт часами, а проверка была
 * только при её создании.
 */
function revokeSubscriptions(budgetId: string, userId: string): void {
  const set = byBudget.get(budgetId);
  if (!set) return;
  for (const client of [...set]) {
    if (client.userId === userId) {
      send(client, { type: 'unsubscribed', budgetId, reason: 'access_revoked' });
      unsubscribe(client, budgetId);
    }
  }
}

export function broadcast(events: SyncEvent[]): void {
  const grouped = new Map<string, SyncEvent[]>();
  for (const event of events) {
    const list = grouped.get(event.budgetId);
    if (list) list.push(event);
    else grouped.set(event.budgetId, [event]);
  }

  for (const [budgetId, list] of grouped) {
    for (const event of list) {
      // Исключение участника обрабатывается до рассылки, чтобы удалённый
      // пользователь не получил событие о собственном удалении вместе
      // с составом участников.
      if (event.entity === 'member' && event.op === 'delete') {
        const removed = (event.payload as { removedUserId?: string })?.removedUserId;
        if (removed) revokeSubscriptions(budgetId, removed);
      }
    }
    const set = byBudget.get(budgetId);
    if (!set) continue;
    for (const client of set) {
      for (const event of list) send(client, { type: 'event', ...event });
    }
  }
}

export function attachRealtime(server: Server): void {
  wss = new WebSocketServer({ server, path: '/ws' });
  setBroadcaster(broadcast);

  wss.on('connection', (socket) => {
    const client: Client = { socket, userId: null, budgets: new Set(), alive: true };
    clients.add(client);

    socket.on('pong', () => { client.alive = true; });

    socket.on('message', async (raw) => {
      let msg: { type?: string; token?: string; budgetId?: string; sinceSeq?: number };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return send(client, { type: 'error', code: 'bad_message' });
      }

      if (msg.type === 'auth') {
        const payload = msg.token ? verifyAccessToken(msg.token) : null;
        if (!payload) {
          send(client, { type: 'error', code: 'unauthorized' });
          return socket.close(4401, 'unauthorized');
        }
        // Смена пользователя на живом сокете сбрасывает все подписки.
        if (client.userId && client.userId !== payload.sub) {
          for (const budgetId of [...client.budgets]) unsubscribe(client, budgetId);
        }
        client.userId = payload.sub;
        return send(client, { type: 'auth.ok', userId: payload.sub });
      }

      if (!client.userId) return send(client, { type: 'error', code: 'unauthorized' });

      if (msg.type === 'subscribe' && msg.budgetId) {
        const budgetId = msg.budgetId;
        const userId = client.userId;

        // Различаем два случая, которые легко перепутать:
        //   sinceSeq отсутствует — клиент пуст, данные придёт брать снапшотом;
        //   sinceSeq = 0         — клиент ЕСТЬ и стоит в начале журнала
        //                          (нормально для только что созданного бюджета),
        //                          значит нужно доиграть всё.
        const since = typeof msg.sinceSeq === 'number' && Number.isFinite(msg.sinceSeq)
          ? Math.max(0, Math.trunc(msg.sinceSeq))
          : null;

        // Одна транзакция на всю подписку, и обязательно с указанием
        // пользователя: WebSocket не проходит через HTTP-хук, который
        // проставляет актора, поэтому в Postgres запросы шли бы без
        // app.user_id — и RLS не отдал бы ни строки. Проверка членства
        // тогда всегда была бы отрицательной.
        const result = await db.tx(async () => {
          if (!(await isMember(userId, budgetId))) return { forbidden: true as const };

          const head = await currentSeq(budgetId);
          if (since === null) return { head, events: [] as SyncEvent[] };

          // Слишком большой разрыв дешевле закрыть полной перезагрузкой,
          // чем проигрывать тысячи событий.
          if ((await countEventsSince(budgetId, since)) > config.maxReplayEvents) {
            return { head, resync: true as const };
          }
          return { head, events: await readEventsSince(budgetId, since, config.maxReplayEvents) };
        }, userId);

        if ('forbidden' in result) {
          return send(client, { type: 'error', code: 'forbidden', budgetId });
        }
        subscribe(client, budgetId);
        if ('resync' in result) {
          return send(client, { type: 'resync', budgetId, seq: result.head });
        }
        return send(client, { type: 'subscribed', budgetId, seq: result.head, events: result.events });
      }

      if (msg.type === 'unsubscribe' && msg.budgetId) {
        unsubscribe(client, msg.budgetId);
        return send(client, { type: 'unsubscribed', budgetId: msg.budgetId, reason: 'client' });
      }

      if (msg.type === 'ping') return send(client, { type: 'pong' });
    });

    socket.on('close', () => detach(client));
    socket.on('error', () => detach(client));
  });

  // Heartbeat: мёртвые соединения в мобильных сетях часто не закрываются
  // корректно, и без ping/pong они копились бы в памяти.
  const interval = setInterval(() => {
    for (const client of [...clients]) {
      if (!client.alive) {
        client.socket.terminate();
        detach(client);
        continue;
      }
      client.alive = false;
      if (client.socket.readyState === WebSocket.OPEN) client.socket.ping();
    }
  }, 25_000);
  interval.unref();

  wss.on('close', () => clearInterval(interval));
  heartbeat = interval;
}

let heartbeat: NodeJS.Timeout | null = null;

/**
 * Открытые WebSocket-соединения удерживают event loop, поэтому корректное
 * завершение процесса требует явного их закрытия — иначе SIGTERM
 * не приводит к остановке, и оркестратор убивает процесс по таймауту.
 */
export function closeRealtime(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  for (const client of [...clients]) {
    client.socket.terminate();
    detach(client);
  }
  return new Promise((resolve) => {
    if (!wss) return resolve();
    wss.close(() => {
      wss = null;
      resolve();
    });
  });
}

export const realtimeStats = () => ({
  connections: clients.size,
  budgets: byBudget.size,
});
