/**
 * Тонкая обёртка над IndexedDB.
 *
 * Хранит две вещи:
 *   snapshots — последний известный снимок бюджета вместе с его seq,
 *               чтобы приложение открывалось мгновенно и работало офлайн;
 *   outbox    — очередь неотправленных мутаций.
 *
 * localStorage для этого не годится: он синхронный (блокирует рендер) и
 * ограничен ~5 МБ, чего мало для года операций.
 */

const DB_NAME = 'checkbudget';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots');
        if (!db.objectStoreNames.contains('outbox')) {
          db.createObjectStore('outbox', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = fn(transaction.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export interface QueuedMutation {
  id: string;
  budgetId: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body: unknown;
  /** Локальный id сущности — по нему оптимистичная запись связывается с ответом. */
  localId: string | null;
  entity: string;
  createdAt: number;
  attempts: number;
  lastError: string | null;
}

export const idb = {
  async getSnapshot<T>(budgetId: string): Promise<T | null> {
    try {
      return (await tx<T>('snapshots', 'readonly', (s) => s.get(budgetId))) ?? null;
    } catch {
      return null; // приватный режим браузера — работаем без локального кеша
    }
  },
  async putSnapshot(budgetId: string, value: unknown): Promise<void> {
    try {
      await tx('snapshots', 'readwrite', (s) => s.put(value, budgetId));
    } catch { /* кеш необязателен */ }
  },
  async listQueue(): Promise<QueuedMutation[]> {
    try {
      const items = await tx<QueuedMutation[]>('outbox', 'readonly', (s) => s.getAll());
      return items.sort((a, b) => a.createdAt - b.createdAt);
    } catch {
      return [];
    }
  },
  async enqueue(item: QueuedMutation): Promise<void> {
    try {
      await tx('outbox', 'readwrite', (s) => s.put(item));
    } catch { /* без очереди мутация останется только оптимистичной */ }
  },
  async dequeue(id: string): Promise<void> {
    try {
      await tx('outbox', 'readwrite', (s) => s.delete(id));
    } catch { /* ignore */ }
  },
  async clearAll(): Promise<void> {
    try {
      await tx('snapshots', 'readwrite', (s) => s.clear());
      await tx('outbox', 'readwrite', (s) => s.clear());
    } catch { /* ignore */ }
  },
};
