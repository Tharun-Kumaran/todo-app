import type { Db } from '../db/client.ts';

export interface SessionRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: Date | string;
  last_seen_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  user_agent: string | null;
  ip_hash: string | null;
}

export interface NewSession {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  ipHash: string | null;
}

const MAX_SESSIONS_PER_USER = 20;

export async function createSession(
  db: Db,
  session: NewSession,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(
      `delete from sessions
        where user_id = $1
          and (expires_at <= now() or revoked_at is not null)`,
      [session.userId],
    );
    await tx.query(
      `delete from sessions
        where id in (
          select id from sessions
           where user_id = $1 and revoked_at is null
           order by created_at desc
           offset $2
        )`,
      [session.userId, MAX_SESSIONS_PER_USER - 1],
    );
    await tx.query(
      `insert into sessions
         (id, user_id, token_hash, created_at, last_seen_at, expires_at, user_agent, ip_hash)
       values ($1, $2, $3, $4::timestamptz, $4::timestamptz, $5::timestamptz, $6, $7)`,
      [
        session.id,
        session.userId,
        session.tokenHash,
        session.createdAt,
        session.expiresAt,
        session.userAgent,
        session.ipHash,
      ],
    );
  });
}

export async function findSessionByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<SessionRow | null> {
  const rows = await db.query<SessionRow>(
    `select id, user_id, token_hash, created_at, last_seen_at, expires_at,
            revoked_at, user_agent, ip_hash
       from sessions
      where token_hash = $1
        and revoked_at is null
        and expires_at > now()`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function listSessionsForUser(
  db: Db,
  userId: string,
): Promise<SessionRow[]> {
  return db.query<SessionRow>(
    `select id, user_id, token_hash, created_at, last_seen_at, expires_at,
            revoked_at, user_agent, ip_hash
       from sessions
      where user_id = $1
        and revoked_at is null
        and expires_at > now()
      order by created_at desc`,
    [userId],
  );
}

export async function touchSession(
  db: Db,
  tokenHash: string,
): Promise<void> {
  await db.query(
    `update sessions
        set last_seen_at = now()
      where token_hash = $1
        and last_seen_at < now() - interval '5 minutes'`,
    [tokenHash],
  );
}

export async function deleteSessionByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<void> {
  await db.query('delete from sessions where token_hash = $1', [tokenHash]);
}

export async function deleteAllSessionsForUser(
  db: Db,
  userId: string,
): Promise<number> {
  const rows = await db.query<{ id: string }>(
    'delete from sessions where user_id = $1 returning id',
    [userId],
  );
  return rows.length;
}

export async function revokeSession(
  db: Db,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `update sessions
        set revoked_at = now()
      where id = $1 and user_id = $2 and revoked_at is null
      returning id`,
    [sessionId, userId],
  );
  return rows.length > 0;
}

export async function revokeOtherSessions(
  db: Db,
  userId: string,
  currentTokenHash: string,
): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `update sessions
        set revoked_at = now()
      where user_id = $1
        and token_hash <> $2
        and revoked_at is null
      returning id`,
    [userId, currentTokenHash],
  );
  return rows.length;
}
