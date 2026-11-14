import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface SessionRecord {
  id: string;
  /** SHA-256 of the opaque token; the raw token only lives in the cookie. */
  tokenHash: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ipHash: string | null;
}

interface SessionFile {
  version: 2;
  sessions: SessionRecord[];
}

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

const MAX_SESSIONS_PER_USER = 20;
const TOUCH_INTERVAL_MS = 5 * 60_000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cloneRecord(record: SessionRecord): SessionRecord {
  return { ...record };
}

function toInfo(record: SessionRecord, currentToken?: string | null): SessionInfo {
  return {
    id: record.id,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    expiresAt: record.expiresAt,
    userAgent: record.userAgent,
    current:
      currentToken !== undefined &&
      currentToken !== null &&
      record.tokenHash === hashToken(currentToken),
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
 * Opaque cookie sessions persisted to disk. Only hashes of tokens are stored,
 * so the sessions file cannot be replayed as a login. Expired sessions are
 * pruned whenever a new one is created.
 */
export class SessionStore {
  private sessions: SessionRecord[] = [];
  private opChain: Promise<unknown> = Promise.resolve();
  private readonly touchTimes = new Map<string, number>();
  private readonly file: string;
  readonly ttlMs: number;

  constructor(file: string, ttlMs: number) {
    this.file = file;
    this.ttlMs = ttlMs;
  }

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SessionFile>;
      const now = Date.now();
      this.sessions = Array.isArray(parsed.sessions)
        ? parsed.sessions
            .map((session) => normalizeSession(session, now))
            .filter((session): session is SessionRecord => session !== null)
        : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.error(`Could not read ${this.file}; starting with no sessions.`, error);
        try {
          await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          // Nothing else we can do; the next write will recreate the file.
        }
      }
      this.sessions = [];
      await this.persist([]);
    }
  }

  /** Create a session and return the raw token for the cookie. */
  create(userId: string, metadata: SessionMetadata = {}): Promise<string> {
    return this.mutate((sessions) => {
      const now = new Date();
      const token = randomBytes(32).toString('base64url');
      const record: SessionRecord = {
        id: randomUUID(),
        tokenHash: hashToken(token),
        userId,
        createdAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
        userAgent: metadata.userAgent?.slice(0, 300) ?? null,
        ipHash: metadata.ipHash ?? null,
      };
      const active = sessions.filter(
        (session) => Date.parse(session.expiresAt) > now.getTime(),
      );
      const forUser = active.filter((session) => session.userId === userId);
      const keepForUser =
        forUser.length >= MAX_SESSIONS_PER_USER
          ? new Set(
              forUser
                .sort(
                  (a, b) =>
                    Date.parse(b.createdAt) - Date.parse(a.createdAt),
                )
                .slice(0, MAX_SESSIONS_PER_USER - 1)
                .map((session) => session.id),
            )
          : new Set(forUser.map((session) => session.id));
      const next = active.filter(
        (session) =>
          session.userId !== userId || keepForUser.has(session.id),
      );
      return { next: [...next, record], result: token };
    });
  }

  userIdFor(token: string): string | null {
    const tokenHash = hashToken(token);
    const session = this.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session) return null;
    if (Date.parse(session.expiresAt) <= Date.now()) return null;
    return session.userId;
  }

  /** Current session metadata, without exposing the token hash. */
  currentSession(token: string): SessionInfo | null {
    const tokenHash = hashToken(token);
    const session = this.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) return null;
    return toInfo(session, token);
  }

  listForUser(userId: string, currentToken?: string | null): SessionInfo[] {
    const now = Date.now();
    return this.sessions
      .filter(
        (session) =>
          session.userId === userId && Date.parse(session.expiresAt) > now,
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((session) => toInfo(session, currentToken));
  }

  /**
   * Update last-seen at most every five minutes per session. Called from the
   * auth middleware without blocking the request.
   */
  touch(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    const now = Date.now();
    const lastTouch = this.touchTimes.get(tokenHash) ?? 0;
    if (now - lastTouch < TOUCH_INTERVAL_MS) return Promise.resolve();
    const session = this.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session) return Promise.resolve();
    this.touchTimes.set(tokenHash, now);
    return this.mutate((sessions) => {
      const next = sessions.map((item) =>
        item.tokenHash === tokenHash
          ? { ...item, lastSeenAt: new Date(now).toISOString() }
          : item,
      );
      return { next, result: undefined };
    });
  }

  destroy(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    this.touchTimes.delete(tokenHash);
    return this.mutate((sessions) => ({
      next: sessions.filter((session) => session.tokenHash !== tokenHash),
      result: undefined,
    }));
  }

  destroyAllForUser(userId: string): Promise<number> {
    return this.mutate((sessions) => {
      const next = sessions.filter((session) => session.userId !== userId);
      return { next, result: sessions.length - next.length };
    });
  }

  async revoke(userId: string, sessionId: string): Promise<boolean> {
    const found = this.sessions.some(
      (session) => session.userId === userId && session.id === sessionId,
    );
    if (!found) return false;
    await this.mutate((sessions) => ({
      next: sessions.filter(
        (session) =>
          !(session.userId === userId && session.id === sessionId),
      ),
      result: undefined,
    }));
    return true;
  }

  revokeOthers(userId: string, currentToken: string): Promise<number> {
    const currentHash = hashToken(currentToken);
    return this.mutate((sessions) => {
      const next = sessions.filter(
        (session) =>
          session.userId !== userId || session.tokenHash === currentHash,
      );
      return { next, result: sessions.length - next.length };
    });
  }

  private mutate<T>(
    fn: (sessions: SessionRecord[]) => {
      next: SessionRecord[];
      result: T;
    },
  ): Promise<T> {
    const run = this.opChain.then(async () => {
      const { next, result } = fn(this.sessions.map(cloneRecord));
      await this.persist(next);
      this.sessions = next;
      return result;
    });
    this.opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async persist(sessions: SessionRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    const body: SessionFile = { version: 2, sessions };
    await fs.writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    await fs.rename(temp, this.file);
  }
}

function normalizeSession(
  value: unknown,
  now: number,
): SessionRecord | null {
  if (!value || typeof value !== 'object') return null;
  const session = value as Record<string, unknown>;
  if (
    typeof session.tokenHash !== 'string' ||
    typeof session.userId !== 'string' ||
    typeof session.createdAt !== 'string' ||
    typeof session.expiresAt !== 'string'
  ) {
    return null;
  }
  const expires = Date.parse(session.expiresAt);
  if (!Number.isFinite(expires) || expires <= now) return null;
  return {
    id:
      typeof session.id === 'string' && session.id.length > 0
        ? session.id
        : randomUUID(),
    tokenHash: session.tokenHash,
    userId: session.userId,
    createdAt: session.createdAt,
    lastSeenAt:
      typeof session.lastSeenAt === 'string' &&
      !Number.isNaN(Date.parse(session.lastSeenAt))
        ? session.lastSeenAt
        : session.createdAt,
    expiresAt: session.expiresAt,
    userAgent:
      typeof session.userAgent === 'string' ? session.userAgent : null,
    ipHash: typeof session.ipHash === 'string' ? session.ipHash : null,
  };
}
