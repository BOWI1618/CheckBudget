import { randomUUID, randomBytes } from 'node:crypto';

export const newId = (): string => randomUUID();

/** Код приглашения: 12 символов из алфавита без визуально похожих букв. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newInviteCode(): string {
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
    if (i === 3 || i === 7) out += '-';
  }
  return out;
}

export const nowIso = (): string => new Date().toISOString();
export const today = (): string => new Date().toISOString().slice(0, 10);
