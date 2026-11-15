import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Db } from './db/client.ts';

/**
 * Persistence for the small JSON-shaped stores (Time Machine state and invite
 * codes). Local development keeps them in files; deployments with Postgres keep
 * them in the `app_state` table so a free host needs no persistent disk.
 */
export interface JsonStateStore<T> {
  readonly kind: 'file' | 'postgres';
  readonly location: string;
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
  /**
   * Reload state written by another process. `changed: false` means the cached
   * copy is still current.
   */
  refresh(): Promise<{ changed: boolean; value: T | null }>;
}

export class FileState<T> implements JsonStateStore<T> {
  readonly kind = 'file' as const;
  readonly location: string;
  private readonly label: string;
  private lastMtimeMs = 0;
  private lastSize = -1;

  constructor(file: string, label: string) {
    this.location = file;
    this.label = label;
  }

  async load(): Promise<T | null> {
    try {
      const raw = await fs.readFile(this.location, 'utf8');
      await this.rememberStat();
      return JSON.parse(raw) as T;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.error(
          `Could not read ${this.location}; starting with empty ${this.label}.`,
          error,
        );
        try {
          await fs.rename(
            this.location,
            `${this.location}.corrupt-${Date.now()}`,
          );
        } catch {
          // The next write recreates the file.
        }
      }
      return null;
    }
  }

  async save(value: T): Promise<void> {
    await fs.mkdir(path.dirname(this.location), { recursive: true });
    const temp = `${this.location}.tmp-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(temp, this.location);
    await this.rememberStat();
  }

  async refresh(): Promise<{ changed: boolean; value: T | null }> {
    try {
      const stat = await fs.stat(this.location);
      if (stat.mtimeMs === this.lastMtimeMs && stat.size === this.lastSize) {
        return { changed: false, value: null };
      }
    } catch {
      return { changed: false, value: null };
    }
    return { changed: true, value: await this.load() };
  }

  private async rememberStat(): Promise<void> {
    try {
      const stat = await fs.stat(this.location);
      this.lastMtimeMs = stat.mtimeMs;
      this.lastSize = stat.size;
    } catch {
      this.lastMtimeMs = 0;
      this.lastSize = -1;
    }
  }
}

export class DbState<T> implements JsonStateStore<T> {
  readonly kind = 'postgres' as const;
  readonly location: string;
  private readonly db: Db;
  private readonly key: string;
  private readonly normalize: (value: unknown) => T;

  constructor(
    db: Db,
    key: string,
    normalize: (value: unknown) => T,
  ) {
    this.db = db;
    this.key = key;
    this.normalize = normalize;
    this.location = `postgres:app_state/${key}`;
  }

  async load(): Promise<T | null> {
    const rows = await this.db.query<{ value: unknown }>(
      'select value from app_state where key = $1',
      [this.key],
    );
    const raw = rows[0]?.value;
    if (raw === undefined || raw === null) return null;
    return this.normalize(typeof raw === 'string' ? JSON.parse(raw) : raw);
  }

  async save(value: T): Promise<void> {
    await this.db.query(
      `insert into app_state (key, value, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (key) do update
         set value = excluded.value, updated_at = now()`,
      [this.key, JSON.stringify(value)],
    );
  }

  async refresh(): Promise<{ changed: boolean; value: T | null }> {
    // The CLI can write invites while the API is running, so always re-read.
    return { changed: true, value: await this.load() };
  }
}
