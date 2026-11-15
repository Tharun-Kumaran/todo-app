import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, getDb } from '../server/db/client.ts';
import { runMigrations } from '../server/db/migrate.ts';
import { InviteStore, inviteDbState } from '../server/invites.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultFile = path.join(here, '..', 'server', 'data', 'invites.json');
const file = process.env.TODO_INVITES_FILE
  ? path.resolve(process.env.TODO_INVITES_FILE)
  : defaultFile;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function numberOption(name: string): number | undefined {
  const raw = option(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Deployed instances keep invites in Postgres. Local development keeps using
 * the JSON file, matching the server's own choice.
 */
async function openStore(): Promise<{
  store: InviteStore;
  close: () => Promise<void>;
}> {
  const usesPostgres =
    process.env.DB_DRIVER?.trim().toLowerCase() === 'postgres';
  if (!usesPostgres) {
    return { store: new InviteStore(file), close: async () => undefined };
  }
  const db = await getDb();
  // The CLI may run before the server's first boot on a fresh database.
  await runMigrations(db);
  return { store: new InviteStore(inviteDbState(db)), close: closeDb };
}

async function run(store: InviteStore): Promise<void> {
  const command = process.argv[2] ?? 'list';

  if (command === 'create') {
    const never = process.argv.includes('--never');
    const created = await store.create({
      email: option('email') ?? null,
      maxUses: numberOption('uses') ?? 1,
      expiresInDays: never ? null : (numberOption('days') ?? 30),
      createdBy: null,
    });
    console.log(`Invite created: ${created.invite.id}`);
    console.log(`Code (shown once): ${created.code}`);
    console.log(
      `Uses: ${created.invite.maxUses}; email: ${created.invite.email ?? 'any'}; expires: ${created.invite.expiresAt ?? 'never'}`,
    );
    console.log(
      `Share this code with the beta user. It is stored only as a hash in ${store.location}.`,
    );
    return;
  }

  if (command === 'revoke') {
    const id = process.argv[3];
    if (!id) {
      console.error('Usage: npm run invite:revoke -- <invite-id>');
      process.exitCode = 1;
      return;
    }
    const revoked = await store.revoke(id);
    console.log(revoked ? `Revoked ${id}.` : `Invite ${id} was not found.`);
    if (!revoked) process.exitCode = 1;
    return;
  }

  if (command === 'list') {
    const invites = store.list();
    if (invites.length === 0) {
      console.log('No invite codes yet.');
      return;
    }
    for (const invite of invites) {
      console.log(
        [
          invite.id,
          invite.exhausted ? 'exhausted' : 'active',
          `${invite.usedCount}/${invite.maxUses} uses`,
          invite.email ?? 'any email',
          invite.expiresAt ? `expires ${invite.expiresAt}` : 'never expires',
        ].join('  '),
      );
    }
    return;
  }

  console.error('Usage: npm run invite:create|invite:list|invite:revoke -- [options]');
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const { store, close } = await openStore();
  try {
    await store.init();
    await run(store);
  } finally {
    await close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
