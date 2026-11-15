import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDb } from './db/client.ts';
import {
  createSession,
  deleteAllSessionsForUser,
  deleteSessionByTokenHash,
  findSessionByTokenHash,
  listSessionsForUser,
  revokeOtherSessions,
  revokeSession,
  touchSession,
  type SessionRow,
} from './repositories/sessions.ts';

export interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  current: boolean;
}

export interface SessionMetadata {
  userAgent?: string | null;
  ipHash?: string | null;
}

export const SESSION_COOKIE = 'todo_session';

export type SameSite = 'Lax' | 'None' | 'Strict';

export interface CookieOptions {
  secure: boolean;
  sameSite: SameSite;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toInfo(row: SessionRow, currentToken?: string | null): SessionInfo {
  return {
    id: row.id,
    createdAt: toIso(row.created_at),
    lastSeenAt: toIso(row.last_seen_at),
    expiresAt: toIso(row.expires_at),
    userAgent: row.user_agent,
    current:
      currentToken !== undefined &&
      currentToken !== null &&
      row.token_hash === hashToken(currentToken),
  };
}

/** Read one cookie value without pulling in a cookie-parsing dependency. */
export function readCookie(
  header: string | undefined,
  name: string,
): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function sessionCookie(
  token: string,
  maxAgeSeconds: number,
  options: CookieOptions,
): string {
  return cookieHeader(
    `${SESSION_COOKIE}=${token}; Max-Age=${maxAgeSeconds}`,
    options,
  );
}

export function clearSessionCookie(options: CookieOptions): string {
  return cookieHeader(`${SESSION_COOKIE}=; Max-Age=0`, options);
}

function cookieHeader(base: string, options: CookieOptions): string {
  const parts = [base, 'HttpOnly', 'Path=/', `SameSite=${options.sameSite}`];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Opaque cookie sessions stored in Postgres/PGlite. Only hashes of tokens are
 * stored, so the sessions table cannot be replayed as a login.
 */
export class SessionStore {
  readonly ttlMs: number;

  constructor(_file?: string, ttlMs = 30 * 86_400_000) {
    this.ttlMs = ttlMs;
  }

  async init(): Promise<void> {
    // The database is opened and migrated by the server bootstrap.
  }

  /** Create a session and return the raw token for the cookie. */
  async create(
    userId: string,
    metadata: SessionMetadata = {},
  ): Promise<string> {
    const now = new Date();
    const token = randomBytes(32).toString('base64url');
    await createSession(await getDb(), {
      id: randomUUID(),
      userId,
      tokenHash: hashToken(token),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      userAgent: metadata.userAgent?.slice(0, 300) ?? null,
      ipHash: metadata.ipHash ?? null,
    });
    return token;
  }

  async userIdFor(token: string): Promise<string | null> {
    const row = await findSessionByTokenHash(await getDb(), hashToken(token));
    return row?.user_id ?? null;
  }

  /** Current session metadata, without exposing the token hash. */
  async currentSession(token: string): Promise<SessionInfo | null> {
    const row = await findSessionByTokenHash(await getDb(), hashToken(token));
    return row ? toInfo(row, token) : null;
  }

  async listForUser(
    userId: string,
    currentToken?: string | null,
  ): Promise<SessionInfo[]> {
    const rows = await listSessionsForUser(await getDb(), userId);
    return rows.map((row) => toInfo(row, currentToken));
  }

  /**
   * Update last-seen at most every five minutes per session. The SQL condition
   * makes this a no-op when another request already touched the row.
   */
  async touch(token: string): Promise<void> {
    await touchSession(await getDb(), hashToken(token));
  }

  async destroy(token: string): Promise<void> {
    await deleteSessionByTokenHash(await getDb(), hashToken(token));
  }

  async destroyAllForUser(userId: string): Promise<number> {
    return deleteAllSessionsForUser(await getDb(), userId);
  }

  async revoke(userId: string, sessionId: string): Promise<boolean> {
    return revokeSession(await getDb(), userId, sessionId);
  }

  async revokeOthers(userId: string, currentToken: string): Promise<number> {
    return revokeOtherSessions(
      await getDb(),
      userId,
      hashToken(currentToken),
    );
  }
}
