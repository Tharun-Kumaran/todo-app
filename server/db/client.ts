import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';

export type DbDriver = 'pglite' | 'postgres';

export interface DbExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  exec(sql: string): Promise<void>;
}

export interface Db extends DbExecutor {
  readonly driver: DbDriver;
  transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DbOptions {
  driver?: DbDriver;
  dataDir?: string;
  connectionString?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

function defaultDataDir(): string {
  return process.env.PGLITE_DATA_DIR
    ? path.resolve(process.env.PGLITE_DATA_DIR)
    : path.join(here, '..', 'data', 'pglite');
}

function configuredDriver(): DbDriver {
  return process.env.DB_DRIVER?.trim().toLowerCase() === 'postgres'
    ? 'postgres'
    : 'pglite';
}

function asRows<T extends Record<string, unknown>>(
  value: unknown,
): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

class PgliteDb implements Db {
  readonly driver = 'pglite' as const;
  private readonly client: PGlite;

  constructor(dataDir: string) {
    // PGlite only creates its own directory; nested custom paths need parents.
    mkdirSync(dataDir, { recursive: true });
    this.client = new PGlite(dataDir);
  }

  async ready(): Promise<void> {
    await this.client.waitReady;
  }

  async query<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.client.query<T>(sql, params);
    return asRows<T>(result.rows);
  }

  async exec(sql: string): Promise<void> {
    await this.client.exec(sql);
  }

  async transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.client.transaction(async (tx) =>
      fn({
        query: async <R extends Record<string, unknown>>(
          sql: string,
          params: unknown[] = [],
        ) => {
          const result = await tx.query<R>(sql, params);
          return asRows<R>(result.rows);
        },
        exec: async (sql: string) => {
          await tx.exec(sql);
        },
      }),
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

class PostgresDb implements Db {
  readonly driver = 'postgres' as const;
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: Number(process.env.DATABASE_POOL_MAX) || 15,
      statement_timeout: 5_000,
    });
  }

  async ready(): Promise<void> {
    const client = await this.pool.connect();
    client.release();
  }

  async query<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query(sql, params);
    return asRows<T>(result.rows);
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await fn({
        query: async <R extends Record<string, unknown>>(
          sql: string,
          params: unknown[] = [],
        ) => {
          const response = await client.query(sql, params);
          return asRows<R>(response.rows);
        },
        exec: async (sql: string) => {
          await client.query(sql);
        },
      });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

let singleton: Db | null = null;
let readyPromise: Promise<Db> | null = null;

export async function createDatabase(options: DbOptions = {}): Promise<Db> {
  const driver = options.driver ?? configuredDriver();
  if (driver === 'postgres') {
    const connectionString =
      options.connectionString ?? process.env.DATABASE_URL ?? '';
    if (!connectionString) {
      throw new Error(
        'DB_DRIVER=postgres requires DATABASE_URL to be set.',
      );
    }
    const db = new PostgresDb(connectionString);
    await db.ready();
    return db;
  }

  const db = new PgliteDb(options.dataDir ?? defaultDataDir());
  await db.ready();
  return db;
}

/** The process-wide database. The first call opens the configured driver. */
export function getDb(): Promise<Db> {
  if (!readyPromise) {
    readyPromise = createDatabase().then((db) => {
      singleton = db;
      return db;
    });
  }
  return readyPromise;
}

export async function closeDb(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = null;
    readyPromise = null;
  }
}

export function dbInfo(): { driver: DbDriver; location: string } {
  const driver = configuredDriver();
  if (driver === 'postgres') {
    const url = process.env.DATABASE_URL ?? '';
    return {
      driver,
      location: url.replace(/:\/\/[^@]*@/, '://***@') || '(unset)',
    };
  }
  return { driver, location: defaultDataDir() };
}
