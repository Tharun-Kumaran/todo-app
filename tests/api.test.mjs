import test from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = process.env.API_BASE || 'http://localhost:3001';

class TestClient {
  constructor() {
    this.cookies = '';
  }

  async request(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(this.cookies ? { Cookie: this.cookies } : {}),
      ...(options.headers || {}),
    };

    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const match = setCookie.match(/todo_session=[^;]+/);
      if (match) {
        this.cookies = match[0];
      }
    }

    let data;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    return { status: res.status, headers: res.headers, data };
  }
}

test('Duplicate Account Validation', async (t) => {
  const clientA = new TestClient();
  const clientB = new TestClient();
  const suffix = Date.now();
  const baseEmail = `dup-user-${suffix}@example.com`;
  const password = 'ValidPassword123!';

  await t.test('Initial account registration succeeds', async () => {
    const res = await clientA.request('/api/auth/register', {
      method: 'POST',
      body: { email: baseEmail, password },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.user.email, baseEmail.toLowerCase());
  });

  await t.test('Exact duplicate registration returns 409 Conflict', async () => {
    const res = await clientB.request('/api/auth/register', {
      method: 'POST',
      body: { email: baseEmail, password },
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.error, 'An account with this email already exists.');
  });

  await t.test('Case-insensitive duplicate registration (UPPERCASE) returns 409 Conflict', async () => {
    const res = await clientB.request('/api/auth/register', {
      method: 'POST',
      body: { email: baseEmail.toUpperCase(), password },
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.error, 'An account with this email already exists.');
  });

  await t.test('Whitespace-padded duplicate registration returns 409 Conflict', async () => {
    const res = await clientB.request('/api/auth/register', {
      method: 'POST',
      body: { email: `  ${baseEmail}  `, password },
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.error, 'An account with this email already exists.');
  });

  await t.test('Mixed-case with whitespace duplicate registration returns 409 Conflict', async () => {
    const res = await clientB.request('/api/auth/register', {
      method: 'POST',
      body: { email: `  ${baseEmail.toUpperCase()}  `, password },
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.error, 'An account with this email already exists.');
  });

  await t.test('Invalid or empty emails are rejected with 400', async () => {
    for (const badEmail of ['', '   ', 'notanemail', 'missing@tld', '@no-local.com']) {
      const res = await clientB.request('/api/auth/register', {
        method: 'POST',
        body: { email: badEmail, password },
      });
      assert.equal(res.status, 400, `Expected 400 for ${badEmail}`);
    }
  });
});

test('No Data Leaking Across Accounts (Strict Isolation)', async (t) => {
  const alice = new TestClient();
  const bob = new TestClient();
  const suffix = Date.now() + 1;
  const aliceEmail = `alice-isolation-${suffix}@example.com`;
  const bobEmail = `bob-isolation-${suffix}@example.com`;
  const password = 'StrongPassword123!';

  let aliceTask1Id;
  let aliceTask2Id;

  await t.test('Setup Alice and Bob accounts', async () => {
    const resAlice = await alice.request('/api/auth/register', {
      method: 'POST',
      body: { email: aliceEmail, password },
    });
    assert.equal(resAlice.status, 201);

    const resBob = await bob.request('/api/auth/register', {
      method: 'POST',
      body: { email: bobEmail, password },
    });
    assert.equal(resBob.status, 201);
  });

  await t.test('Verify no password, salt, or hash leakage in auth responses', async () => {
    const meAlice = await alice.request('/api/auth/me');
    assert.equal(meAlice.status, 200);
    assert.equal(meAlice.data.user.email, aliceEmail);
    assert.equal(meAlice.data.user.password, undefined);
    assert.equal(meAlice.data.user.salt, undefined);
    assert.equal(meAlice.data.user.passwordHash, undefined);
  });

  await t.test('Alice creates active and completed tasks with milestones', async () => {
    // Task 1: Active task with milestone
    const res1 = await alice.request('/api/tasks', {
      method: 'POST',
      body: { text: "Alice's Secret Project Task", dueAt: new Date(Date.now() + 100000).toISOString() },
    });
    assert.equal(res1.status, 201);
    aliceTask1Id = res1.data.task.id;

    // Add milestone
    const msRes = await alice.request(`/api/tasks/${aliceTask1Id}/milestones`, {
      method: 'POST',
      body: { text: "Alice's confidential checkpoint", progress: 40 },
    });
    assert.equal(msRes.status, 201);

    // Task 2: Completed task
    const res2 = await alice.request('/api/tasks', {
      method: 'POST',
      body: { text: "Alice's Completed Task" },
    });
    assert.equal(res2.status, 201);
    aliceTask2Id = res2.data.task.id;

    await alice.request(`/api/tasks/${aliceTask2Id}`, {
      method: 'PATCH',
      body: { done: true },
    });
  });

  await t.test("Bob's task list is completely empty (no leakage of Alice's tasks)", async () => {
    const res = await bob.request('/api/tasks');
    assert.equal(res.status, 200);
    assert.equal(res.data.tasks.length, 0);
  });

  await t.test("Bob cannot GET Alice's task by ID (returns 404, not 200 or 403)", async () => {
    const res = await bob.request(`/api/tasks/${aliceTask1Id}`);
    assert.equal(res.status, 404);
    assert.deepEqual(res.data, { error: 'Task not found.' });
  });

  await t.test("Bob cannot PATCH/modify Alice's task text, done, or progress", async () => {
    const res = await bob.request(`/api/tasks/${aliceTask1Id}`, {
      method: 'PATCH',
      body: { text: 'Hacked by Bob', done: true, progress: 100 },
    });
    assert.equal(res.status, 404);

    // Verify Alice's task remains untouched
    const checkAlice = await alice.request(`/api/tasks/${aliceTask1Id}`);
    assert.equal(checkAlice.status, 200);
    assert.equal(checkAlice.data.task.text, "Alice's Secret Project Task");
    assert.equal(checkAlice.data.task.done, false);
    assert.equal(checkAlice.data.task.progress, 40);
  });

  await t.test("Bob cannot add milestones to Alice's task", async () => {
    const res = await bob.request(`/api/tasks/${aliceTask1Id}/milestones`, {
      method: 'POST',
      body: { text: 'Injected milestone by Bob', progress: 99 },
    });
    assert.equal(res.status, 404);

    // Verify Alice's task milestones
    const checkAlice = await alice.request(`/api/tasks/${aliceTask1Id}`);
    assert.equal(checkAlice.data.task.milestones.length, 1);
    assert.equal(checkAlice.data.task.milestones[0].text, "Alice's confidential checkpoint");
  });

  await t.test("Bob cannot DELETE Alice's task", async () => {
    const res = await bob.request(`/api/tasks/${aliceTask1Id}`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 404);

    // Verify Alice still has the task
    const checkAlice = await alice.request(`/api/tasks/${aliceTask1Id}`);
    assert.equal(checkAlice.status, 200);
  });

  await t.test("Bob calling clear-completed does NOT delete Alice's completed tasks", async () => {
    const res = await bob.request('/api/tasks/clear-completed', {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.tasks, []);

    // Verify Alice's completed task is still intact
    const checkAlice = await alice.request(`/api/tasks/${aliceTask2Id}`);
    assert.equal(checkAlice.status, 200);
    assert.equal(checkAlice.data.task.done, true);
  });

  await t.test("Bob cannot hijack or inject Alice's task into Bob's list via reorder", async () => {
    // Bob attempts to put Alice's task ID into his reorder list
    const res = await bob.request('/api/tasks/order', {
      method: 'PUT',
      body: { ids: [aliceTask1Id, aliceTask2Id] },
    });
    assert.equal(res.status, 200);
    // Bob's list must still be empty!
    assert.equal(res.data.tasks.length, 0);

    // Alice's task list must remain intact in count and ownership
    const checkAlice = await alice.request('/api/tasks');
    assert.equal(checkAlice.data.tasks.length, 2);
    assert.ok(checkAlice.data.tasks.some((t) => t.id === aliceTask1Id));
    assert.ok(checkAlice.data.tasks.some((t) => t.id === aliceTask2Id));
  });

  await t.test('Bob creates his own task; Alice cannot see or modify it', async () => {
    const bobTaskRes = await bob.request('/api/tasks', {
      method: 'POST',
      body: { text: "Bob's private note" },
    });
    assert.equal(bobTaskRes.status, 201);
    const bobTaskId = bobTaskRes.data.task.id;

    // Alice cannot get Bob's task
    const aliceGetBob = await alice.request(`/api/tasks/${bobTaskId}`);
    assert.equal(aliceGetBob.status, 404);

    // Alice's list only has 2 tasks
    const aliceList = await alice.request('/api/tasks');
    assert.equal(aliceList.data.tasks.length, 2);
    assert.ok(!aliceList.data.tasks.some((t) => t.id === bobTaskId));

    // Bob's list only has 1 task
    const bobList = await bob.request('/api/tasks');
    assert.equal(bobList.data.tasks.length, 1);
    assert.equal(bobList.data.tasks[0].id, bobTaskId);
  });
});
