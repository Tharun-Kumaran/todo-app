import type { Db } from './client.ts';
import { INITIAL_SCHEMA_SQL, INITIAL_SCHEMA_VERSION } from './schema.ts';

const SERIES_OCCURRENCES_VERSION = '002_series_occurrences';

/**
 * A series may create at most one task per occurrence. The unique index also
 * covers soft-deleted rows on purpose: skipping or deleting an occurrence must
 * not cause the scheduler to recreate it.
 */
const SERIES_OCCURRENCES_SQL = `
create unique index if not exists tasks_series_occurrence_uq
  on tasks (series_id, occurrence_at)
  where series_id is not null and occurrence_at is not null;
`;

const MIGRATIONS: Array<{ version: string; sql: string }> = [
  { version: INITIAL_SCHEMA_VERSION, sql: INITIAL_SCHEMA_SQL },
  { version: SERIES_OCCURRENCES_VERSION, sql: SERIES_OCCURRENCES_SQL },
];

/** Version a freshly migrated database reports. */
export const LATEST_SCHEMA_VERSION =
  MIGRATIONS[MIGRATIONS.length - 1]?.version ?? INITIAL_SCHEMA_VERSION;

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
