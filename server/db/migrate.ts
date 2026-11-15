import type { Db } from './client.ts';
import { INITIAL_SCHEMA_SQL, INITIAL_SCHEMA_VERSION } from './schema.ts';

const MIGRATIONS: Array<{ version: string; sql: string }> = [
  { version: INITIAL_SCHEMA_VERSION, sql: INITIAL_SCHEMA_SQL },
];

/**
 * Apply migrations in order. Each migration and its bookkeeping row commit
 * together, so a failed migration leaves the database unchanged.
 */
export async function runMigrations(db: Db): Promise<string[]> {
  await db.exec(`
    create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    );
  `);

  const appliedRows = await db.query<{ version: string }>(
    'select version from schema_migrations order by version',
  );
  const applied = new Set(appliedRows.map((row) => row.version));
  const newlyApplied: string[] = [];

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query(
        'insert into schema_migrations (version) values ($1)',
        [migration.version],
      );
    });
    newlyApplied.push(migration.version);
  }

  return newlyApplied;
}

export async function schemaVersion(db: Db): Promise<string | null> {
  try {
    const rows = await db.query<{ version: string }>(
      'select version from schema_migrations order by version desc limit 1',
    );
    return rows[0]?.version ?? null;
  } catch {
    return null;
  }
}
