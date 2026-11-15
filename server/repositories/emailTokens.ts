import type { Db } from '../db/client.ts';

export type EmailTokenKind =
  | 'verify_email'
  | 'reset_password'
  | 'change_email';

export interface EmailTokenRecord {
  id: string;
  userId: string;
  email: string;
  kind: EmailTokenKind;
  expiresAt: string;
}

interface EmailTokenRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  email: string;
  kind: EmailTokenKind;
  expires_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Store a one-time token by hash only. Tokens are never written in plaintext,
 * so a database leak cannot be replayed as a verification or reset link.
 */
export async function createEmailToken(
  db: Db,
  input: {
    id: string;
    userId: string;
    kind: EmailTokenKind;
    tokenHash: string;
    expiresAt: string;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    // Only the newest link for a given purpose should stay usable.
    await tx.query(
      `update email_tokens
          set used_at = now()
        where user_id = $1 and kind = $2 and used_at is null`,
      [input.userId, input.kind],
    );
    await tx.query(
      `insert into email_tokens (id, user_id, kind, token_hash, expires_at)
       values ($1, $2, $3, $4, $5::timestamptz)`,
      [input.id, input.userId, input.kind, input.tokenHash, input.expiresAt],
    );
  });
}

/** Find an unused, unexpired token and the email it belongs to. */
export async function findEmailToken(
  db: Db,
  tokenHash: string,
  kind: EmailTokenKind,
  now = new Date(),
): Promise<EmailTokenRecord | null> {
  const rows = await db.query<EmailTokenRow>(
    `select t.id, t.user_id, u.email, t.kind, t.expires_at
       from email_tokens t
       join users u on u.id = t.user_id
      where t.token_hash = $1
        and t.kind = $2
        and t.used_at is null
        and t.expires_at > $3::timestamptz
        and u.deleted_at is null
        and u.disabled_at is null`,
    [tokenHash, kind, now.toISOString()],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    kind: row.kind,
    expiresAt: toIso(row.expires_at),
  };
}

/**
 * Mark a token used exactly once. Returns false when another request already
 * consumed it, which keeps reset/verification links single-use under races.
 */
export async function consumeEmailToken(
  db: Db,
  tokenHash: string,
  kind: EmailTokenKind,
): Promise<EmailTokenRecord | null> {
  const rows = await db.query<EmailTokenRow>(
    `update email_tokens t
        set used_at = now()
       from users u
      where t.token_hash = $1
        and t.kind = $2
        and t.used_at is null
        and t.expires_at > now()
        and u.id = t.user_id
        and u.deleted_at is null
        and u.disabled_at is null
      returning t.id, t.user_id, u.email, t.kind, t.expires_at`,
    [tokenHash, kind],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    kind: row.kind,
    expiresAt: toIso(row.expires_at),
  };
}

/** Invalidate every outstanding link of one kind for a user. */
export async function revokeEmailTokens(
  db: Db,
  userId: string,
  kind: EmailTokenKind,
): Promise<void> {
  await db.query(
    `update email_tokens
        set used_at = now()
      where user_id = $1 and kind = $2 and used_at is null`,
    [userId, kind],
  );
}
