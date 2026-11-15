import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../server/db/client.ts';
import { runMigration } from '../scripts/migrate-json-to-db.ts';

const PASSWORD = 'LegacyPass123!';
const N = 16_384;
const R = 8;
const P = 1;

async function writeFixtures(dir) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(PASSWORD, salt, 64, { N, R, P }).toString('hex');
  const userId = randomUUID();
  const teamId = randomUUID();
  const now = Date.now();
  const iso = (days) => new Date(now + days * 86_400_000).toISOString();

  const user = {
    id: userId,
    email: 'Legacy@Example.com',
    salt,
    passwordHash: hash,
    createdAt: iso(-30),
  };
  const team = {
    id: teamId,
    name: 'Legacy Team',
    ownerId: userId,
    ownerEmail: user.email,
    createdAt: iso(-20),
    members: [{ email: user.email, role: 'owner', joinedAt: iso(-20) }],
  };
  const doneTaskId = randomUUID();
  const openTaskId = randomUUID();
  const tasks = [
    {
      id: doneTaskId,
      userId,
      creatorEmail: user.email,
      teamId: null,
      text: 'Finished legacy task',
      done: true,
      progress: 100,
      priority: 'High',
      category: 'Work',
      dueAt: iso(-1),
      completedAt: iso(-2),
      createdAt: iso(-10),
      updatedAt: iso(-2),
      version: 3,
      milestones: [
        { id: randomUUID(), text: 'Started early', progress: 40, createdAt: iso(-8) },
        { text: 'Almost there', progress: 90, createdAt: iso(-4) },
      ],
    },
    {
      id: openTaskId,
      userId,
      creatorEmail: user.email,
      teamId,
      assigneeEmail: user.email,
      text: 'Open legacy team task',
      done: false,
      progress: 25,
      priority: 'Low',
      category: null,
      dueAt: iso(3),
      completedAt: null,
      createdAt: iso(-5),
      updatedAt: iso(-1),
      version: 2,
      milestones: [{ text: 'Kickoff', progress: 25, createdAt: iso(-3) }],
    },
    {
      // Legacy files can contain non-UUID ids; they must be reported, not crash.
      id: 'task_not_a_uuid',
      userId,
      text: 'Task with a non-UUID id',
      done: false,
      progress: 0,
    },
  ];

  await fs.mkdir(dir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(dir, 'users.json'), JSON.stringify({ users: [user] })),
    fs.writeFile(path.join(dir, 'teams.json'), JSON.stringify({ teams: [team] })),
    fs.writeFile(path.join(dir, 'tasks.json'), JSON.stringify({ tasks })),
  ]);

  return {
    userId,
    teamId,
    doneTaskId,
    openTaskId,
    passwordHash: `scrypt$${N}$${R}$${P}$${salt}$${hash}`,
    files: {
      users: path.join(dir, 'users.json'),
      teams: path.join(dir, 'teams.json'),
      tasks: path.join(dir, 'tasks.json'),
    },
  };
}

test('legacy JSON import: dry run, apply, idempotency, and verification', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-migrate-'));
  const previous = {
    driver: process.env.DB_DRIVER,
    dataDir: process.env.PGLITE_DATA_DIR,
  };
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DATA_DIR = path.join(root, 'db');

  try {
    const fixture = await writeFixtures(path.join(root, 'data'));

    const dry = await runMigration({
      apply: false,
      verify: false,
      files: fixture.files,
    });
    assert.ok(dry.report);
    assert.equal(dry.report.mode, 'dry-run');
    assert.equal(dry.report.users.imported, 1);
    assert.equal(dry.report.teams.imported, 1);
    assert.equal(dry.report.tasks.imported, 2);
    assert.equal(dry.report.tasks.errors, 1);
    assert.equal(dry.report.milestones, 3);
    assert.equal(dry.report.events, 6);
    assert.equal(dry.report.outcomes, 1);

    const untouched = await createDatabase();
    assert.equal((await untouched.query('select id from users')).length, 0);
    assert.equal((await untouched.query('select id from tasks')).length, 0);
    await untouched.close();

    const first = await runMigration({
      apply: true,
      verify: false,
      files: fixture.files,
    });
    assert.ok(first.report);
    assert.equal(first.report.mode, 'apply');
    assert.equal(first.report.users.imported, 1);
    assert.equal(first.report.teams.imported, 1);
    assert.equal(first.report.tasks.imported, 2);
    assert.equal(first.report.milestones, 3);
    assert.equal(first.report.events, 6);
    assert.equal(first.report.outcomes, 1);
    assert.match(first.report.warnings.join('\n'), /task_not_a_uuid/);

    const second = await runMigration({
      apply: true,
      verify: false,
      files: fixture.files,
    });
    assert.ok(second.report);
    assert.equal(second.report.users.imported, 0);
    assert.equal(second.report.users.skipped, 1);
    assert.equal(second.report.teams.skipped, 1);
    assert.equal(second.report.tasks.imported, 0);
    assert.equal(second.report.tasks.skipped, 2);
    assert.equal(second.report.events, 0);

    const verified = await runMigration({
      apply: false,
      verify: true,
      files: fixture.files,
    });
    const result = verified.verification;
    assert.ok(result);
    assert.deepEqual(result.users.missing, []);
    assert.deepEqual(result.teams.missing, []);
    assert.deepEqual(result.tasks.missing, []);
    assert.deepEqual(result.tasksWithoutEvents, []);
    assert.equal(result.milestones.actual, 3);
    assert.equal(result.outcomes.actual, 1);
    assert.equal(result.unmigratable.tasks, 1);

    const db = await createDatabase();
    try {
      const users = await db.query(
        'select id, email, password_hash from users where id = $1',
        [fixture.userId],
      );
      assert.equal(users.length, 1);
      assert.equal(users[0].email, 'legacy@example.com');
      assert.equal(users[0].password_hash, fixture.passwordHash);
      assert.ok(String(users[0].password_hash).startsWith('scrypt$16384$8$1$'));

      const done = await db.query(
        'select done, progress, completed_at, priority, category, team_id from tasks where id = $1',
        [fixture.doneTaskId],
      );
      assert.equal(done[0].done, true);
      assert.equal(Number(done[0].progress), 100);
      assert.ok(done[0].completed_at instanceof Date);
      assert.equal(done[0].priority, 'High');
      assert.equal(done[0].category, 'Work');
      assert.equal(done[0].team_id, null);

      const events = await db.query(
        'select type from task_events where task_id = $1 order by occurred_at asc, id asc',
        [fixture.doneTaskId],
      );
      assert.deepEqual(
        events.map((event) => event.type),
        ['task.created', 'task.milestone_added', 'task.milestone_added', 'task.completed'],
      );

      const members = await db.query(
        'select email, user_id, role from team_members where team_id = $1',
        [fixture.teamId],
      );
      assert.equal(members.length, 1);
      assert.equal(members[0].user_id, fixture.userId);
      assert.equal(members[0].role, 'owner');
    } finally {
      await db.close();
    }
  } finally {
    if (previous.driver === undefined) delete process.env.DB_DRIVER;
    else process.env.DB_DRIVER = previous.driver;
    if (previous.dataDir === undefined) delete process.env.PGLITE_DATA_DIR;
    else process.env.PGLITE_DATA_DIR = previous.dataDir;
    await fs.rm(root, { recursive: true, force: true });
  }
});
