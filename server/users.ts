import { randomUUID } from 'node:crypto';
import type { User } from '../shared/types';
import { getDb } from './db/client.ts';
import {
  createUser,
  findUserByEmail,
  findUserById,
  removeUser,
  countUsers,
  type UserRecord,
} from './repositories/users.ts';
import { hashPassword, verifyPassword } from './password.ts';

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

/**
 * Accounts live in Postgres (or PGlite locally). Passwords are salted and
 * hashed with scrypt; the plaintext is never stored or returned.
 */
export class UserStore {
  /** Kept for constructor compatibility; the database is the store now. */
  constructor(_file?: string) {}

  async init(): Promise<void> {
    // The database is opened and migrated by the server bootstrap.
  }

  async count(): Promise<number> {
    return countUsers(await getDb());
  }

  async findById(id: string): Promise<User | null> {
    const record = await findUserById(await getDb(), id);
    return record ? toPublicUser(record) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const record = await findUserByEmail(await getDb(), email);
    return record ? toPublicUser(record) : null;
  }

  /** Create an account, or return null when the email is already registered. */
  async create(email: string, password: string): Promise<User | null> {
    const passwordHash = await hashPassword(password);
    const record = await createUser(await getDb(), {
      id: randomUUID(),
      email,
      passwordHash,
    });
    return record ? toPublicUser(record) : null;
  }

  /** Permanently remove an account after its data has been cleaned up. */
  async remove(userId: string): Promise<boolean> {
    return removeUser(await getDb(), userId);
  }

  /** Verify an email/password pair without revealing whether the email exists. */
  async authenticate(email: string, password: string): Promise<User | null> {
    const record = await findUserByEmail(await getDb(), email);
    const valid = await verifyPassword(
      password,
      record?.passwordHash ?? '',
    );
    if (!record || !valid) return null;
    return toPublicUser(record);
  }
}
