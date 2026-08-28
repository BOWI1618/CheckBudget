import { createHash } from 'node:crypto';
import { db } from '../db/index.js';
import { unprocessable } from './errors.js';
import { nowIso } from './ids.js';
import { config } from '../config.js';

export interface StoredResponse {
  statusCode: number;
  body: unknown;
}

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256').update(`${method} ${url} ${JSON.stringify(body ?? null)}`).digest('hex');

/**
 * At-least-once доставка со стороны клиента + идемпотентность на сервере
 * = ровно один эффект. Это то, что делает безопасным повтор запроса
 * при обрыве связи: пользователь в метро нажал «Сохранить», ответ не дошёл,
 * клиент повторил — дубля операции не будет.
 */
export async function lookupIdempotent(
  key: string,
  userId: string,
  method: string,
  url: string,
  body: unknown,
): Promise<StoredResponse | null> {
  const row = await db.get<{ request_hash: string; status_code: number; response: string }>(
    'SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = ? AND user_id = ?',
    key,
    userId,
  );
  if (!row) return null;
  if (row.request_hash !== hashRequest(method, url, body)) {
    throw unprocessable(
      'idempotency_key_reuse',
      'Этот ключ идемпотентности уже использован с другими данными',
    );
  }
  return { statusCode: row.status_code, body: JSON.parse(row.response) };
}

export async function saveIdempotent(
  key: string,
  userId: string,
  method: string,
  url: string,
  body: unknown,
  statusCode: number,
  response: unknown,
): Promise<void> {
  // ON CONFLICT вместо INSERT OR REPLACE: первое понимают оба движка,
  // второе — только SQLite.
  await db.run(
    `INSERT INTO idempotency_keys
       (key, user_id, request_hash, status_code, response, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (key, user_id) DO UPDATE SET
       request_hash = excluded.request_hash,
       status_code  = excluded.status_code,
       response     = excluded.response,
       created_at   = excluded.created_at`,
    key,
    userId,
    hashRequest(method, url, body),
    statusCode,
    JSON.stringify(response ?? null),
    nowIso(),
  );
}

export async function purgeExpiredIdempotencyKeys(): Promise<void> {
  const cutoff = new Date(Date.now() - config.idempotencyRetentionHours * 3600_000).toISOString();
  await db.run('DELETE FROM idempotency_keys WHERE created_at < ?', cutoff);
}
