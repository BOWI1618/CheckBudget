import pg from 'pg';
import type { EntityType, EventOp, SyncEvent } from '@checkbudget/shared';
import { config } from '../config.js';

/**
 * Рассылка событий между инстансами приложения.
 *
 * Хаб WebSocket живёт в памяти процесса: он знает только своих подписчиков.
 * Как только инстансов больше одного, изменение, сделанное через инстанс A,
 * не доходит до клиентов, подключённых к инстансу B, — и приложение выглядит
 * сломанным ровно в тот момент, когда его начали масштабировать.
 *
 * Механизм — LISTEN/NOTIFY в Postgres, а не Redis. Уведомление несёт только
 * `budgetId:seq`; сами события каждый инстанс дочитывает из таблицы `events`.
 * Три причины сделать именно так:
 *
 *   1. NOTIFY ограничен 8000 байтами — полезная нагрузка в него не влезает
 *      и, что важнее, не должна: событие уже надёжно лежит в журнале.
 *   2. Уведомление может потеряться (разрыв соединения, переполнение очереди).
 *      Дочитывание по seq делает потерю безвредной: следующее уведомление
 *      по тому же бюджету заберёт и пропущенное.
 *   3. Postgres уже есть. Redis добавил бы ещё одну точку отказа ради
 *      частоты событий, до которой этому приложению далеко.
 *
 * Порог смены механизма — примерно 1000 событий в секунду: NOTIFY сериализуется
 * через один процесс Postgres, и на такой частоте он становится узким местом.
 */

const CHANNEL = 'checkbudget_events';

type Handler = (events: SyncEvent[]) => void;

interface EventRow {
  seq: number; budget_id: string; entity: string; entity_id: string;
  op: string; actor_id: string; actor_client_id: string | null;
  payload: string; created_at: string; display_name: string | null;
}

export class EventFanout {
  private listener: pg.Client | null = null;
  private reader: pg.Pool | null = null;
  private closed = false;
  private reconnectAttempt = 0;

  /**
   * Позиция, до которой события уже разосланы, по каждому бюджету.
   * Нужна, чтобы дочитывать хвост, а не одно уведомлённое событие:
   * при потерянном уведомлении пропущенное уедет со следующим.
   */
  private delivered = new Map<string, number>();

  constructor(private readonly url: string, private readonly onEvents: Handler) {}

  async start(): Promise<void> {
    this.reader = new pg.Pool({ connectionString: this.url, max: 2 });
    this.reader.on('error', (err) => {
      console.error('[fanout] ошибка соединения чтения:', err.message);
    });
    await this.connectListener();
  }

  /**
   * Отдельное соединение под LISTEN.
   *
   * Из пула его брать нельзя: LISTEN действует на сессию, а пул отдаёт
   * соединение следующему запросу — подписка либо потеряется, либо
   * достанется чужому коду.
   */
  private async connectListener(): Promise<void> {
    if (this.closed) return;

    const client = new pg.Client({ connectionString: this.url });
    client.on('error', (err) => {
      console.error('[fanout] обрыв слушателя:', err.message);
      this.scheduleReconnect();
    });
    client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      void this.drain(msg.payload).catch((err) => {
        console.error('[fanout] не удалось дочитать события:', err.message);
      });
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.listener = client;
      this.reconnectAttempt = 0;

      // После переподключения могли прийти события, уведомления о которых
      // не дошли. Догружаем хвост по всем бюджетам, за которыми следим.
      for (const budgetId of this.delivered.keys()) await this.drain(budgetId);
    } catch (err) {
      console.error('[fanout] не удалось подключить слушателя:', (err as Error).message);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.listener) return;
    const client = this.listener;
    this.listener = null;
    void client.end().catch(() => undefined);

    const delay = Math.min(1000 * 2 ** this.reconnectAttempt++, 30_000);
    setTimeout(() => void this.connectListener(), delay / 2 + Math.random() * (delay / 2)).unref();
  }

  /**
   * Отмечает, что инстанс следит за бюджетом и уже находится на позиции seq.
   * Вызывается хабом при первой подписке на бюджет.
   */
  track(budgetId: string, seq: number): void {
    const known = this.delivered.get(budgetId);
    if (known === undefined || seq > known) this.delivered.set(budgetId, seq);
  }

  untrack(budgetId: string): void {
    this.delivered.delete(budgetId);
  }

  /** Дочитывает и раздаёт всё, что появилось в журнале после известной позиции. */
  private async drain(payload: string): Promise<void> {
    const budgetId = payload.split(':')[0]!;
    const since = this.delivered.get(budgetId);
    // За бюджетом никто не следит — читать нечего.
    if (since === undefined || !this.reader) return;

    const { rows } = await this.reader.query<EventRow>(
      `SELECT e.*, u.display_name
         FROM events e
         LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.budget_id = $1 AND e.seq > $2
        ORDER BY e.seq ASC
        LIMIT $3`,
      [budgetId, since, config.maxReplayEvents],
    );
    if (rows.length === 0) return;

    this.delivered.set(budgetId, Number(rows[rows.length - 1]!.seq));

    this.onEvents(rows.map((r) => ({
      seq: Number(r.seq),
      budgetId: r.budget_id,
      entity: r.entity as EntityType,
      entityId: r.entity_id,
      op: r.op as EventOp,
      actorId: r.actor_id,
      actorClientId: r.actor_client_id,
      actorName: r.display_name ?? 'Участник',
      payload: JSON.parse(r.payload),
      createdAt: r.created_at,
    })));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.listener?.end().catch(() => undefined);
    await this.reader?.end().catch(() => undefined);
  }
}

export const FANOUT_CHANNEL = CHANNEL;
