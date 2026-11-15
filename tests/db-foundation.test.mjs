import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../server/db/client.ts';
import { runMigrations, schemaVersion } from '../server/db/migrate.ts';
import { createUser } from '../server/repositories/users.ts';
import {
  addMilestones,
  createTask,
  getTaskForUser,
  listTasksForUser,
  removeTask,
  updateTask,
} from '../server/repositories/tasks.ts';
import { listTaskEvents } from '../server/repositories/events.ts';
import { hashPassword } from '../server/password.ts';

async function withDb(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-db-'));
  const db = await createDatabase({ driver: 'pglite', dataDir: dir });
  try {
    await runMigrations(db);
    await fn(db, dir);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function taskFor(userId, overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    userId,
    creatorEmail: 'owner@example.com',
    teamId: null,
    assigneeEmail: null,
    text: 'Ship the beta',
    done: false,
    progress: 0,
    priority: 'Medium',
    category: null,
    dueAt: null,
    scheduledStartAt: null,
    reminderAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
    milestones: [],
    ...overrides,
  };
}

test('migrations apply once and report the schema version', async () => {
  await withDb(async (db) => {
    assert.equal(await schemaVersion(db), '001_initial');
    assert.deepEqual(await runMigrations(db), []);
  });
});

test('task mutations write transactional task_events', async () => {
  await withDb(async (db) => {
    const passwordHash = await hashPassword('SecurePassword123!');
    const owner = await createUser(db, {
      id: randomUUID(),
      email: 'owner@example.com',
      passwordHash,
    });
    assert.ok(owner);

    const task = await createTask(db, taskFor(owner.id));
    const updated = await updateTask(db, owner.id, task.id, [], {
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      priority: 'High',
    });
    assert.ok(updated);
    assert.equal(updated.version, 2);

    const withMilestone = await addMilestones(db, owner.id, task.id, [], [
      { text: 'Draft the release notes', progress: 50 },
    ]);
    assert.ok(withMilestone);
    assert.equal(withMilestone.progress, 50);

    await updateTask(db, owner.id, task.id, [], { done: true });
    await removeTask(db, owner.id, task.id, []);

    const events = await listTaskEvents(db, task.id, owner.id);
    const types = events.map((event) => event.type);
    assert.deepEqual(types, [
      'task.created',
      'task.due_changed',
      'task.priority_changed',
      'task.milestone_added',
      'task.progress_changed',
      'task.progress_changed',
      'task.completed',
      'task.deleted',
    ]);
    assert.equal(events[0].payload.source, 'manual');
    assert.equal(events[3].payload.progress, 50);
    assert.equal(events[4].payload.after, 50);
    assert.equal(events[5].payload.after, 100);
    assert.equal(events.at(-1).payload.done, true);
  });
});

test('repository reads and writes are isolated by owner', async () => {
  await withDb(async (db) => {
    const passwordHash = await hashPassword('SecurePassword123!');
    const alice = await createUser(db, {
      id: randomUUID(),
      email: 'alice@example.com',
      passwordHash,
    });
    const bob = await createUser(db, {
      id: randomUUID(),
      email: 'bob@example.com',
      passwordHash,
    });
    assert.ok(alice && bob);

    const task = await createTask(db, taskFor(alice.id));
    assert.equal(await getTaskForUser(db, bob.id, task.id, []), null);
    assert.deepEqual(await listTasksForUser(db, bob.id, null), []);
    assert.equal((await listTasksForUser(db, alice.id, null)).length, 1);
    assert.equal(await removeTask(db, bob.id, task.id, []), false);
  });
});

test('a failed transaction leaves no partial writes', async () => {
  await withDb(async (db) => {
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query(
          `insert into audit_log (action) values ('rollback-test')`,
        );
        throw new Error('boom');
      }),
      /boom/,
    );
    const rows = await db.query(
      `select id from audit_log where action = 'rollback-test'`,
    );
    assert.equal(rows.length, 0);
  });
});
