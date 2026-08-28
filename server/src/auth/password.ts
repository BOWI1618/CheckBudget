import { scrypt as scryptCb, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const maxmem = 256 * 1024 * 1024;

/**
 * Формат хеша: scrypt$N$r$p$<salt base64>$<hash base64>
 * Параметры хранятся вместе с хешем, чтобы их можно было усилить
 * в будущем без инвалидации существующих паролей.
 */
export async function hashPassword(password: string): Promise<string> {
  const { N, r, p, keylen } = config.scrypt;
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, keylen, { N, r, p, maxmem });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  try {
    const actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
