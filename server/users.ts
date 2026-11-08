import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { User } from '../shared/types';

interface UserRecord extends User {
  salt: string;
  passwordHash: string;
}

interface UserFile {
  version: 1;
  users: UserRecord[];
}

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KEY_LENGTH = 64;
// Used for unknown emails so a failed login takes the same time as a real one.
const DUMMY_SALT = '6f3c1a9e5b2d8470c4a6e8f1d3b5c709';

function deriveKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Lowercase, trim, and validate an email address. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return null;
  return EMAIL_PATTERN.test(email) ? email : null;
}

/** Returns a human-readable problem, or null when the password is acceptable. */
export function passwordProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

function toPublicUser(record: UserRecord): User {
  return {
    id: record.id,
    email: record.email,
    createdAt: record.createdAt,
  };
}

function cloneRecord(record: UserRecord): UserRecord {
  return { ...record };
}

/**
 * Accounts stored in an atomic JSON file. Passwords are salted and hashed
 * with scrypt; the plaintext is never written or returned.
 */
export class UserStore {
  private users: UserRecord[] = [];
  private opChain: Promise<unknown> = Promise.resolve();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<UserFile>;
      const seen = new Set<string>();
      this.users = Array.isArray(parsed.users)
        ? parsed.users
            .map(normalizeUser)
            .filter((user): user is UserRecord => {
              if (!user) return false;
              if (seen.has(user.email)) return false;
              seen.add(user.email);
              return true;
            })
        : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.error(`Could not read ${this.file}; starting with no accounts.`, error);
        try {
          await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          // Nothing else we can do; the next write will recreate the file.
        }
      }
      this.users = [];
      await this.persist([]);
    }
  }

  count(): number {
    return this.users.length;
  }

  findById(id: string): User | null {
    const user = this.users.find((record) => record.id === id);
    return user ? toPublicUser(user) : null;
  }

  /** Create an account, or return null when the email is already registered. */
  create(email: string, password: string): Promise<User | null> {
    return this.mutate(async (users) => {
      if (users.some((record) => record.email === email)) {
        return { next: users, result: null };
      }

      const salt = randomBytes(16).toString('hex');
      const passwordHash = (await deriveKey(password, salt)).toString('hex');
      const record: UserRecord = {
        id: randomUUID(),
        email,
        createdAt: new Date().toISOString(),
        salt,
        passwordHash,
      };

      return { next: [...users, record], result: toPublicUser(record) };
    });
  }

  /** Verify an email/password pair without revealing whether the email exists. */
  async authenticate(email: string, password: string): Promise<User | null> {
    const record = this.users.find((item) => item.email === email);
    const key = await deriveKey(password, record?.salt ?? DUMMY_SALT);
    if (!record) return null;

    const expected = Buffer.from(record.passwordHash, 'hex');
    if (
      expected.length !== key.length ||
      !timingSafeEqual(expected, key)
    ) {
      return null;
    }
    return toPublicUser(record);
  }

  private mutate<T>(
    fn: (users: UserRecord[]) => Promise<{ next: UserRecord[]; result: T }>,
  ): Promise<T> {
    const run = this.opChain.then(async () => {
      const { next, result } = await fn(this.users.map(cloneRecord));
      await this.persist(next);
      this.users = next;
      return result;
    });
    this.opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async persist(users: UserRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    const body: UserFile = { version: 1, users };
    await fs.writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    await fs.rename(temp, this.file);
  }
}

function normalizeUser(value: unknown): UserRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.salt !== 'string' ||
    typeof record.passwordHash !== 'string'
  ) {
    return null;
  }
  const email = normalizeEmail(record.email);
  if (!email) return null;
  return {
    id: record.id,
    email,
    createdAt: record.createdAt,
    salt: record.salt,
    passwordHash: record.passwordHash,
  };
}
