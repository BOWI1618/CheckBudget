import { AsyncLocalStorage } from 'node:async_hooks';
import type { EntityType, EventOp, SyncEvent } from '@checkbudget/shared';
import { db } from '../db/index.js';
import { nowIso } from './ids.js';
import { currentClientId } from './context.js';

export interface EmitInput {
  budgetId: string;
  entity: EntityType;
  entityId: string;
  op: EventOp;
  actorId: string;
  payload: unknown;
}

export type Emit = (input: EmitInput) => Promise<void>;

type Broadcaster = (events: SyncEvent[]) => void;
let broadcaster: Broadcaster = () => {};
export const setBroadcaster = (fn: Broadcaster): void => {
  broadcaster = fn;
};

const actorNameCache = new Map<string, string>();

async function actorName(userId: string): Promise<string> {
  let name = actorNameCache.get(userId);
  if (name === undefined) {
    const row = await db.get<{ display_name: string }>(
      'SELECT display_name FROM users WHERE id = ?',
      userId,
    );
    name = row?.display_name ?? 'Участник';
    actorNameCache.set(userId, name);
  }
  return name;
}

export const invalidateActorName = (userId: string): void => {
  actorNameCache.delete(userId);
};

/**
 * Буфер событий текущей единицы работы.
 *
 * Существует, чтобы рассылка шла ровно один раз и ровно после коммита
 * внешней транзакции. Если бы каждый mutate() рассылал сам, вложенный вызов
 * отправил бы события до того, как внешняя транзакция зафиксирована —
 * и при её откате клиенты получили бы изменения, которых в базе нет.
 */
const eventBuffer = new AsyncLocalStorage<SyncEvent[]>();

/**
 * Единица работы: одна транзакция на запрос.
 *
 * Даёт три вещи, каждая из которых важна сама по себе:
 *
 *   1. Атомарность идемпотентности. Раньше ключ сохранялся ОТДЕЛЬНОЙ
 *      транзакцией после мутации: падение между ними означало применённое
 *      изменение без записи о ключе — и повтор клиента создавал дубль.
 *      Ровно то, от чего идемпотентность и должна защищать.
 *   2. Один `SET LOCAL app.user_id` на запрос вместо одного на каждый запрос
 *      к БД — маршрут со снимком делал их семь.
 *   3. Рассылка событий строго после коммита, один раз.
 */
export async function unitOfWork<T>(actorId: string, fn: () => Promise<T>): Promise<T> {
  if (eventBuffer.getStore()) return fn();   // уже внутри единицы работы

  const collected: SyncEvent[] = [];
  const result = await eventBuffer.run(collected, () => db.tx(fn, actorId));
  if (collected.length > 0) broadcaster(collected);
  return result;
}

/**
 * Выполняет мутацию и записывает события в журнал.
 *
 * Событие пишется в таблицу `events` в той же транзакции, что и сама мутация
 * (transactional outbox). Это даёт две гарантии:
 *   — событие не может «потеряться», если broadcast не дошёл: клиент догрузит
 *     его по seq при переподключении;
 *   — событие не может «прийти раньше», чем изменение стало видимым в БД.
 *
 * `actorId` передаётся отдельным параметром, а не берётся из emit: транзакция
 * должна объявить пользователя ДО первого запроса, иначе RLS в Postgres
 * не пропустит даже чтение.
 */
export async function mutate<T>(actorId: string, fn: (emit: Emit) => Promise<T>): Promise<T> {
  return unitOfWork(actorId, async () => {
    const collected = eventBuffer.getStore()!;
    return fn(async (input) => {
      const createdAt = nowIso();
      const clientId = currentClientId();

      // RETURNING, а не lastInsertRowid: последнее есть только у SQLite,
      // а seq нужен обоим драйверам одинаково.
      const inserted = await db.get<{ seq: number }>(
        `INSERT INTO events (budget_id, entity, entity_id, op, actor_id, actor_client_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING seq`,
        input.budgetId,
        input.entity,
        input.entityId,
        input.op,
        input.actorId,
        clientId,
        JSON.stringify(input.payload ?? null),
        createdAt,
      );

      collected.push({
        seq: Number(inserted!.seq),
        budgetId: input.budgetId,
        entity: input.entity,
        entityId: input.entityId,
        op: input.op,
        actorId: input.actorId,
        actorClientId: clientId,
        actorName: await actorName(input.actorId),
        payload: input.payload,
        createdAt,
      });
    });
  });
}

export async function readEventsSince(
  budgetId: string,
  sinceSeq: number,
  limit: number,
): Promise<SyncEvent[]> {
  const rows = await db.all<{
    seq: number; budget_id: string; entity: string; entity_id: string;
    op: string; actor_id: string; actor_client_id: string | null;
    payload: string; created_at: string;
  }>(
    `SELECT * FROM events WHERE budget_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
    budgetId,
    sinceSeq,
    limit,
  );

  return Promise.all(rows.map(async (r) => ({
    seq: Number(r.seq),
    budgetId: r.budget_id,
    entity: r.entity as EntityType,
    entityId: r.entity_id,
    op: r.op as EventOp,
    actorId: r.actor_id,
    actorClientId: r.actor_client_id,
    actorName: await actorName(r.actor_id),
    payload: JSON.parse(r.payload),
    createdAt: r.created_at,
  })));
}

export async function currentSeq(budgetId: string): Promise<number> {
  const row = await db.get<{ seq: number | null }>(
    'SELECT MAX(seq) AS seq FROM events WHERE budget_id = ?',
    budgetId,
  );
  return Number(row?.seq ?? 0);
}

export async function countEventsSince(budgetId: string, sinceSeq: number): Promise<number> {
  const row = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM events WHERE budget_id = ? AND seq > ?',
    budgetId,
    sinceSeq,
  );
  return Number(row?.n ?? 0);
}
