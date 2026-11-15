/**
 * Verify a Postgres connection before deploying.
 *
 * Usage (PowerShell):
 *   $env:DB_DRIVER='postgres'; $env:DATABASE_URL='postgres://...'; $env:DATABASE_SSL='require'; npm run db:check
 *
 * With no environment set it checks the local PGlite database instead.
 */
import { createDatabase, dbInfo } from '../server/db/client';

const db = await createDatabase();
try {
  const rows = await db.query<{ version: string }>('select version() as version');
  const info = dbInfo();
  console.log(`Driver:  ${info.driver}`);
  console.log(`Target:  ${info.location}`);
  console.log(`Server:  ${rows[0]?.version ?? 'unknown'}`);
  console.log('Connection OK.');
} finally {
  await db.close();
}
