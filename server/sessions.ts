import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface SessionRecord {
  /** SHA-256 of the opaque token; the raw token only lives in the cookie. */
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

interface SessionFile {
  version: 1;
  sessions: SessionRecord[];
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
        ? parsed.sessions.filter(
            (session): session is SessionRecord =>
              normalizeSession(session, now),
          )
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
  create(userId: string): Promise<string> {
    return this.mutate((sessions) => {
      const now = new Date();
      const token = randomBytes(32).toString('base64url');
      const record: SessionRecord = {
        tokenHash: hashToken(token),
        userId,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      };
      const active = sessions.filter(
        (session) => Date.parse(session.expiresAt) > now.getTime(),
      );
      return { next: [...active, record], result: token };
    });
  }

  userIdFor(token: string): string | null {
    const tokenHash = hashToken(token);
    const session = this.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session) return null;
    if (Date.parse(session.expiresAt) <= Date.now()) return null;
    return session.userId;
  }

  destroy(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    return this.mutate((sessions) => ({
      next: sessions.filter((session) => session.tokenHash !== tokenHash),
      result: undefined,
    }));
  }

  private mutate<T>(
    fn: (sessions: SessionRecord[]) => {
      next: SessionRecord[];
      result: T;
    },
  ): Promise<T> {
    const run = this.opChain.then(async () => {
      const { next, result } = fn(this.sessions.map((item) => ({ ...item })));
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
    const body: SessionFile = { version: 1, sessions };
    await fs.writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    await fs.rename(temp, this.file);
  }
}

function normalizeSession(value: unknown, now: number): value is SessionRecord {
  if (!value || typeof value !== 'object') return false;
  const session = value as Record<string, unknown>;
  if (
    typeof session.tokenHash !== 'string' ||
    typeof session.userId !== 'string' ||
    typeof session.createdAt !== 'string' ||
    typeof session.expiresAt !== 'string'
  ) {
    return false;
  }
  const expires = Date.parse(session.expiresAt);
  return Number.isFinite(expires) && expires > now;
}
