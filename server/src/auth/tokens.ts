import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * Минимальная реализация JWT HS256.
 *
 * Библиотека не используется намеренно: нужен ровно один алгоритм,
 * он хардкожен при верификации, поэтому классическая атака подмены `alg`
 * (`none`/RS256→HS256) здесь невозможна по построению.
 */

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64url');

export interface AccessTokenPayload {
  sub: string;
  exp: number;
  iat: number;
}

export function signAccessToken(userId: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload: AccessTokenPayload = { sub: userId, iat, exp: iat + config.accessTokenTtlSec };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', config.jwtSecret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];

  const expected = createHmac('sha256', config.jwtSecret).update(`${head}.${body}`).digest();
  const provided = Buffer.from(sig, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  try {
    const header = JSON.parse(Buffer.from(head, 'base64url').toString());
    if (header.alg !== 'HS256') return null; // жёстко фиксируем алгоритм
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as AccessTokenPayload;
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Refresh-токен — просто случайные байты. В БД лежит только его SHA-256. */
export const newRefreshToken = (): string => randomBytes(32).toString('base64url');
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
