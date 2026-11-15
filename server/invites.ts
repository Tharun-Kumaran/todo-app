import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from './db/client.ts';
import {
  DbState,
  FileState,
  type JsonStateStore,
} from './jsonState.ts';
import { normalizeEmail } from './users.ts';

interface InviteRecord {
  id: string;
  codeHash: string;
  email: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: string | null;
  createdAt: string;
  createdBy: string | null;
  revokedAt: string | null;
}

interface InviteFile {
  version: 1;
  invites: InviteRecord[];
}

export interface PublicInvite {
  id: string;
  email: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  exhausted: boolean;
}

export interface CreatedInvite {
  invite: PublicInvite;
  code: string;
}

export type InviteConsumeResult =
  | { ok: true; invite: PublicInvite }
  | {
      ok: false;
      reason: 'invalid' | 'expired' | 'exhausted' | 'email_mismatch' | 'revoked';
    };

export interface CreateInviteOptions {
  email?: string | null;
  maxUses?: number;
  expiresInDays?: number | null;
  createdBy?: string | null;
}

function emptyFile(): InviteFile {
  return { version: 1, invites: [] };
}

function hashCode(code: string): string {
  return createHash('sha256').update(code.trim()).digest('hex');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toPublic(record: InviteRecord): PublicInvite {
  return {
    id: record.id,
    email: record.email,
    maxUses: record.maxUses,
    usedCount: record.usedCount,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
    exhausted:
      record.revokedAt !== null ||
      record.usedCount >= record.maxUses ||
      (record.expiresAt !== null && Date.parse(record.expiresAt) <= Date.now()),
  };
}

function normalizeInvite(value: unknown): InviteRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.codeHash !== 'string' ||
    typeof record.maxUses !== 'number' ||
    typeof record.usedCount !== 'number' ||
    typeof record.createdAt !== 'string'
  ) {
    return null;
  }
  return {
    id: record.id,
    codeHash: record.codeHash,
    email: normalizeEmail(record.email),
    maxUses: Math.max(1, Math.round(record.maxUses)),
    usedCount: Math.max(0, Math.round(record.usedCount)),
    expiresAt:
      typeof record.expiresAt === 'string' &&
      !Number.isNaN(Date.parse(record.expiresAt))
        ? record.expiresAt
        : null,
    createdAt: record.createdAt,
    createdBy: typeof record.createdBy === 'string' ? record.createdBy : null,
    revokedAt:
      typeof record.revokedAt === 'string' &&
      !Number.isNaN(Date.parse(record.revokedAt))
        ? record.revokedAt
        : null,
  };
}

export function normalizeInviteFile(value: unknown): InviteFile {
  const parsed = (value ?? {}) as Partial<InviteFile>;
  return {
    version: 1,
    invites: Array.isArray(parsed.invites)
      ? parsed.invites
          .map(normalizeInvite)
          .filter((invite): invite is InviteRecord => invite !== null)
      : [],
  };
}

/**
 * Invite-only beta codes. Only a SHA-256 hash of each code is stored; the raw
 * code is shown once when it is created and can never be recovered.
 */
export class InviteStore {
  private data: InviteFile = emptyFile();
  private opChain: Promise<unknown> = Promise.resolve();
  private readonly state: JsonStateStore<InviteFile>;
  readonly location: string;

  constructor(fileOrState: string | JsonStateStore<InviteFile>) {
    this.state =
      typeof fileOrState === 'string'
        ? new FileState(fileOrState, 'invite codes')
        : fileOrState;
    this.location = this.state.location;
  }

  async init(): Promise<void> {
    const loaded = await this.state.load();
    this.data = loaded ? normalizeInviteFile(loaded) : emptyFile();
    if (!loaded) {
      await this.persist(this.data);
    }
  }

  /**
   * Pick up codes created or revoked by the CLI while the API process is
   * running. Files are only reloaded when their size or mtime changes; the
   * Postgres store is re-read on every check.
   */
  async refresh(): Promise<void> {
    try {
      const { changed, value } = await this.state.refresh();
      if (!changed) return;
      this.data = value ? normalizeInviteFile(value) : emptyFile();
    } catch (error) {
      console.error(
        `Could not refresh ${this.location}; keeping current invites.`,
        error,
      );
    }
  }

  async create(options: CreateInviteOptions = {}): Promise<CreatedInvite> {
    const code = randomBytes(18).toString('base64url');
    const now = new Date();
    const expiresInDays =
      options.expiresInDays === null
        ? null
        : options.expiresInDays === undefined
          ? 30
          : options.expiresInDays;
    const record: InviteRecord = {
      id: randomUUID(),
      codeHash: hashCode(code),
      email: normalizeEmail(options.email),
      maxUses: Math.max(1, Math.round(options.maxUses ?? 1)),
      usedCount: 0,
      expiresAt:
        expiresInDays === null
          ? null
          : new Date(now.getTime() + expiresInDays * 86_400_000).toISOString(),
      createdAt: now.toISOString(),
      createdBy: options.createdBy ?? null,
      revokedAt: null,
    };

    return this.mutate((data) => ({
      next: { ...data, invites: [record, ...data.invites] },
      result: { invite: toPublic(record), code },
    }));
  }

  list(): PublicInvite[] {
    return this.data.invites.map(toPublic);
  }

  async consume(code: string, email: string): Promise<InviteConsumeResult> {
    await this.refresh();
    const codeHash = hashCode(code);
    const normalizedEmail = normalizeEmail(email);
    return this.mutate<InviteConsumeResult>((data) => {
      const index = data.invites.findIndex(
        (invite) => invite.codeHash === codeHash,
      );
      if (index === -1) {
        return { next: data, result: { ok: false, reason: 'invalid' } };
      }
      const invite = data.invites[index];
      if (invite.revokedAt !== null) {
        return { next: data, result: { ok: false, reason: 'revoked' } };
      }
      if (
        invite.expiresAt !== null &&
        Date.parse(invite.expiresAt) <= Date.now()
      ) {
        return { next: data, result: { ok: false, reason: 'expired' } };
      }
      if (invite.usedCount >= invite.maxUses) {
        return { next: data, result: { ok: false, reason: 'exhausted' } };
      }
      if (
        invite.email !== null &&
        normalizedEmail !== null &&
        invite.email !== normalizedEmail
      ) {
        return { next: data, result: { ok: false, reason: 'email_mismatch' } };
      }

      const updated: InviteRecord = {
        ...invite,
        usedCount: invite.usedCount + 1,
      };
      const invites = data.invites.map((entry, entryIndex) =>
        entryIndex === index ? updated : entry,
      );
      return {
        next: { ...data, invites },
        result: { ok: true, invite: toPublic(updated) },
      };
    });
  }

  /** Return a use when account creation fails after the code was consumed. */
  async release(code: string): Promise<boolean> {
    const codeHash = hashCode(code);
    return this.mutate((data) => {
      const index = data.invites.findIndex(
        (invite) => invite.codeHash === codeHash,
      );
      if (index === -1) return { next: data, result: false };
      const invite = data.invites[index];
      if (invite.usedCount <= 0) return { next: data, result: false };
      const updated: InviteRecord = {
        ...invite,
        usedCount: invite.usedCount - 1,
      };
      const invites = data.invites.map((entry, entryIndex) =>
        entryIndex === index ? updated : entry,
      );
      return { next: { ...data, invites }, result: true };
    });
  }

  async revoke(id: string): Promise<boolean> {
    return this.mutate((data) => {
      let changed = false;
      const invites = data.invites.map((invite) => {
        if (invite.id !== id || invite.revokedAt !== null) return invite;
        changed = true;
        return { ...invite, revokedAt: new Date().toISOString() };
      });
      return { next: { ...data, invites }, result: changed };
    });
  }

  private mutate<T>(
    fn: (data: InviteFile) => { next: InviteFile; result: T },
  ): Promise<T> {
    const run = this.opChain.then(async () => {
      const { next, result } = fn(clone(this.data));
      await this.persist(next);
      this.data = next;
      return result;
    });
    this.opChain = run.catch(() => {});
    return run;
  }

  private async persist(data: InviteFile): Promise<void> {
    await this.state.save(data);
  }
}

/** Postgres-backed invite storage for deployed instances. */
export function inviteDbState(db: Db): JsonStateStore<InviteFile> {
  return new DbState(db, 'invites', normalizeInviteFile);
}
