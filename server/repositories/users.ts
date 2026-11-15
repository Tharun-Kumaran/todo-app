import type { User } from '../../shared/types';
import type { Db, DbExecutor } from '../db/client.ts';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

interface UserRow extends Record<string, unknown> {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    createdAt: toIso(row.created_at),
  };
}

export function toUserRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: toIso(row.created_at),
  };
}

export async function countUsers(db: Db): Promise<number> {
  const rows = await db.query<{ count: number | string }>(
    'select count(*)::int as count from users where deleted_at is null',
  );
  return Number(rows[0]?.count ?? 0);
}

export async function findUserById(
  db: Db,
  id: string,
): Promise<UserRecord | null> {
  const rows = await db.query<UserRow>(
    `select id, email, password_hash, created_at
       from users
      where id = $1 and deleted_at is null`,
    [id],
  );
  return rows[0] ? toUserRecord(rows[0]) : null;
}

export async function findUserByEmail(
  db: Db,
  email: string,
): Promise<UserRecord | null> {
  const rows = await db.query<UserRow>(
    `select id, email, password_hash, created_at
       from users
      where lower(email) = lower($1) and deleted_at is null`,
    [email],
  );
  return rows[0] ? toUserRecord(rows[0]) : null;
}

export async function createUser(
  db: Db,
  input: { id: string; email: string; passwordHash: string; createdAt?: string },
): Promise<UserRecord | null> {
  try {
    return await db.transaction(async (tx) => {
      const rows = await tx.query<UserRow>(
        `insert into users (id, email, password_hash, created_at, updated_at)
         values ($1, lower($2), $3, coalesce($4::timestamptz, now()), now())
         returning id, email, password_hash, created_at`,
        [
          input.id,
          input.email,
          input.passwordHash,
          input.createdAt ?? null,
        ],
      );
      await ensureUserSettings(tx, input.id);
      return rows[0] ? toUserRecord(rows[0]) : null;
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return null;
    throw error;
  }
}

export async function removeUser(db: Db, userId: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    'delete from users where id = $1 returning id',
    [userId],
  );
  return rows.length > 0;
}

export async function ensureUserSettings(
  db: DbExecutor,
  userId: string,
): Promise<void> {
  await db.query(
    `insert into user_settings (user_id)
     values ($1)
     on conflict (user_id) do nothing`,
    [userId],
  );
}
