/**
 * Import the legacy Time Machine and invite JSON files into the `app_state`
 * table. Deployed instances keep both stores in Postgres; this script carries
 * existing local state over when moving off PGlite.
 *
 * Usage:
 *   npm run state:import                # dry run, reports what would change
 *   npm run state:import -- --apply     # write the rows
 *   npm run state:import -- --apply --force  # replace existing rows
 *
 * Reads TODO_TIME_MACHINE_FILE / TODO_INVITES_FILE for non-default locations.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, getDb } from '../server/db/client.ts';
import { runMigrations } from '../server/db/migrate.ts';
import { DbState } from '../server/jsonState.ts';
import { normalizeInviteFile } from '../server/invites.ts';
import { normalizeTimeMachineFile } from '../server/timeMachineStore.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const timeMachineFile = process.env.TODO_TIME_MACHINE_FILE
  ? path.resolve(process.env.TODO_TIME_MACHINE_FILE)
  : path.join(here, '..', 'server', 'data', 'time-machine.json');
const invitesFile = process.env.TODO_INVITES_FILE
  ? path.resolve(process.env.TODO_INVITES_FILE)
  : path.join(here, '..', 'server', 'data', 'invites.json');

const apply = process.argv.includes('--apply');
const force = process.argv.includes('--force');

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function main(): Promise<void> {
  const db = await getDb();
  try {
    await runMigrations(db);

    const timeMachine = new DbState(
      db,
      'time-machine',
      normalizeTimeMachineFile,
    );
    const invites = new DbState(db, 'invites', normalizeInviteFile);

    const existingTimeMachine = await timeMachine.load();
    const timeMachineJson = await readJson(timeMachineFile);
    if (timeMachineJson === null) {
      console.log(`No Time Machine file at ${timeMachineFile}; skipped.`);
    } else {
      const parsed = normalizeTimeMachineFile(timeMachineJson);
      console.log(
        `Time Machine: ${parsed.predictions.length} predictions, ` +
          `${parsed.recommendations.length} recommendations, ` +
          `${parsed.series.length} series, ${parsed.reminders.length} reminders.`,
      );
      if (existingTimeMachine && !force) {
        console.log(
          '  Postgres already has Time Machine data; use --force to replace it.',
        );
      } else if (apply) {
        await timeMachine.save(parsed);
        console.log('  Imported into app_state.');
      } else {
        console.log('  Dry run; re-run with --apply to import.');
      }
    }

    const existingInvites = await invites.load();
    const invitesJson = await readJson(invitesFile);
    if (invitesJson === null) {
      console.log(`No invite file at ${invitesFile}; skipped.`);
    } else {
      const parsed = normalizeInviteFile(invitesJson);
      console.log(`Invites: ${parsed.invites.length} codes.`);
      if (existingInvites && !force) {
        console.log(
          '  Postgres already has invite codes; use --force to replace them.',
        );
      } else if (apply) {
        await invites.save(parsed);
        console.log('  Imported into app_state.');
      } else {
        console.log('  Dry run; re-run with --apply to import.');
      }
    }
  } finally {
    await closeDb();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
