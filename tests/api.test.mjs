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
});

test('Personal Tasks vs Team Tasks & Multi-User Collaboration', async (t) => {
  const host = new TestClient();
  const teammate = new TestClient();
  const outsider = new TestClient();

  const suffix = Date.now() + 10;
  const hostEmail = `host-${suffix}@example.com`;
  const teammateEmail = `teammate-${suffix}@example.com`;
  const outsiderEmail = `outsider-${suffix}@example.com`;
  const password = 'SecurePassword123!';

  let teamId;
  let hostPersonalTaskId;
  let teamTaskId;

  await t.test('Register all three users', async () => {
    const r1 = await host.request('/api/auth/register', {
      method: 'POST',
      body: { email: hostEmail, password },
    });
    assert.equal(r1.status, 201);

    const r2 = await teammate.request('/api/auth/register', {
      method: 'POST',
      body: { email: teammateEmail, password },
    });
    assert.equal(r2.status, 201);

    const r3 = await outsider.request('/api/auth/register', {
      method: 'POST',
      body: { email: outsiderEmail, password },
    });
    assert.equal(r3.status, 201);
  });

  await t.test('Host creates a private Personal Task', async () => {
    const res = await host.request('/api/tasks', {
      method: 'POST',
      body: { text: 'Host Private Personal Task' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.task.teamId, null);
    hostPersonalTaskId = res.data.task.id;
  });

  await t.test('Neither Teammate nor Outsider can see Host Personal Task', async () => {
    const res1 = await teammate.request('/api/tasks');
    assert.equal(res1.status, 200);
    assert.equal(res1.data.tasks.length, 0);

    const res2 = await outsider.request(`/api/tasks/${hostPersonalTaskId}`);
    assert.equal(res2.status, 404);
  });

  await t.test('Host creates a Team', async () => {
    const res = await host.request('/api/teams', {
      method: 'POST',
      body: { name: 'Alpha Core Team' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.team.name, 'Alpha Core Team');
    assert.equal(res.data.team.ownerEmail, hostEmail.toLowerCase());
    assert.equal(res.data.team.members.length, 1);
    assert.equal(res.data.team.members[0].role, 'owner');
    teamId = res.data.team.id;
  });

  await t.test('Host invites Teammate by email', async () => {
    const res = await host.request(`/api/teams/${teamId}/members`, {
      method: 'POST',
      body: { email: teammateEmail },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.team.members.length, 2);
    assert.ok(res.data.team.members.some((m) => m.email === teammateEmail.toLowerCase()));
  });

  await t.test('Teammate can now view the team in their teams list', async () => {
    const res = await teammate.request('/api/teams');
    assert.equal(res.status, 200);
    assert.equal(res.data.teams.length, 1);
    assert.equal(res.data.teams[0].id, teamId);
  });

  await t.test('Host creates a Team Task assigned to Teammate', async () => {
    const res = await host.request('/api/tasks', {
      method: 'POST',
      body: {
        text: 'Build Team Feature Dashboard',
        teamId,
        assigneeEmail: teammateEmail,
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.task.teamId, teamId);
    assert.equal(res.data.task.creatorEmail, hostEmail.toLowerCase());
    assert.equal(res.data.task.assigneeEmail, teammateEmail.toLowerCase());
    teamTaskId = res.data.task.id;
  });

  await t.test('Teammate can see and monitor the Team Task', async () => {
    const res = await teammate.request(`/api/tasks?teamId=${teamId}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.tasks.length, 1);
    assert.equal(res.data.tasks[0].id, teamTaskId);
    assert.equal(res.data.tasks[0].text, 'Build Team Feature Dashboard');
    assert.equal(res.data.tasks[0].assigneeEmail, teammateEmail.toLowerCase());
  });

  await t.test('Teammate posts progress milestone update on Team Task', async () => {
    const msRes = await teammate.request(`/api/tasks/${teamTaskId}/milestones`, {
      method: 'POST',
      body: { text: 'Frontend UI layout completed', progress: 50 },
    });
    assert.equal(msRes.status, 201);
    assert.equal(msRes.data.task.progress, 50);
    assert.equal(msRes.data.task.milestones.length, 1);

    // Host monitors the update
    const hostCheck = await host.request(`/api/tasks/${teamTaskId}`);
    assert.equal(hostCheck.status, 200);
    assert.equal(hostCheck.data.task.progress, 50);
    assert.equal(hostCheck.data.task.milestones[0].text, 'Frontend UI layout completed');
  });

  await t.test('Outsider is forbidden from accessing the Team Task and Team details', async () => {
    const resTeam = await outsider.request(`/api/teams/${teamId}`);
    assert.equal(resTeam.status, 404);

    const resTask = await outsider.request(`/api/tasks/${teamTaskId}`);
    assert.equal(resTask.status, 404);

    const resTasks = await outsider.request(`/api/tasks?teamId=${teamId}`);
    assert.equal(resTasks.status, 403);
  });

  await t.test('Personal tasks remain completely separate from Team tasks', async () => {
    // Host personal tasks count is 1
    const hostPersonal = await host.request('/api/tasks');
    assert.equal(hostPersonal.status, 200);
    assert.equal(hostPersonal.data.tasks.length, 1);
    assert.equal(hostPersonal.data.tasks[0].id, hostPersonalTaskId);

    // Host team tasks count is 1
    const hostTeam = await host.request(`/api/tasks?teamId=${teamId}`);
    assert.equal(hostTeam.status, 200);
    assert.equal(hostTeam.data.tasks.length, 1);
    assert.equal(hostTeam.data.tasks[0].id, teamTaskId);

    // Teammate personal tasks count is 0
    const tmPersonal = await teammate.request('/api/tasks');
    assert.equal(tmPersonal.status, 200);
    assert.equal(tmPersonal.data.tasks.length, 0);
  });
});
