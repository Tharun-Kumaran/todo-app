import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * PHC-style scrypt string: scrypt$N$r$p$saltHex$hashHex.
 *
 * The parameters are stored with the hash so they can be raised later without
 * invalidating existing accounts.
 */
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

const DUMMY_SALT = '6f3c1a9e5b2d8470c4a6e8f1d3b5c709';

function deriveKey(
  password: string,
  salt: string,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: n, r, p, maxmem: MAX_MEMORY },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt}$${key.toString('hex')}`;
}

export function legacyHashToPhc(salt: string, hash: string): string {
  return `scrypt$${N}$${R}$${P}$${salt}$${hash}`;
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4];
  const hash = parts[5];
  if (
    !Number.isFinite(n) ||
    !Number.isFinite(r) ||
    !Number.isFinite(p) ||
    !salt ||
    !hash
  ) {
    return null;
  }
  return { n, r, p, salt, hash };
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parsed = parseHash(stored);
  // Unknown accounts still pay the scrypt cost so login timing does not
  // reveal whether an email is registered.
  const target = parsed ?? {
    n: N,
    r: R,
    p: P,
    salt: DUMMY_SALT,
    hash: '00'.repeat(KEY_LENGTH),
  };
  const key = await deriveKey(password, target.salt, target.n, target.r, target.p);
  const expected = Buffer.from(target.hash, 'hex');
  if (expected.length !== key.length) return false;
  const equal = timingSafeEqual(expected, key);
  return parsed !== null && equal;
}

export function dummyPasswordHash(): string {
  return `scrypt$${N}$${R}$${P}$${DUMMY_SALT}$${'00'.repeat(KEY_LENGTH)}`;
}
