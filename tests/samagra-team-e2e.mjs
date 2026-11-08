import test from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = process.env.API_BASE || 'http://localhost:3001';

class SessionClient {
  constructor(name) {
    this.name = name;
    this.cookies = '';
    this.user = null;
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
      if (match) this.cookies = match[0];
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

test('Samagra Team Scaffolding, Account Sync & Real-Time Sync E2E', async (t) => {
  const primary = new SessionClient('Primary Account (Owner)');
  const secondary = new SessionClient('Secondary Account (Collaborator)');

  const suffix = Date.now();
  const primaryEmail = `samagra.owner+${suffix}@gmail.com`;
  const secondaryEmail = `samagra.collab+${suffix}@gmail.com`;
  const password = 'GooglePass123!';
  const teamName = 'samagra';
  const deadlineSept25 = new Date('2026-09-25T19:00:00.000Z').toISOString();

  let teamId;
  let taskId;
  let primaryPersonalTaskId;

  // 1. Primary Account Setup & Workspace Scaffolding
  await t.test('1. Primary Google account registers and gets session', async () => {
    const res = await primary.request('/api/auth/register', {
      method: 'POST',
      body: { email: primaryEmail, password },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.user.email, primaryEmail.toLowerCase());
    primary.user = res.data.user;
  });

  await t.test('2. Primary account creates a private personal task (My Tasks)', async () => {
    const res = await primary.request('/api/tasks', {
      method: 'POST',
      body: { text: 'Owner private personal note' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.task.teamId, null);
    primaryPersonalTaskId = res.data.task.id;
  });

  await t.test('3. Primary account creates "samagra" workspace and is designated as Owner', async () => {
    const res = await primary.request('/api/teams', {
      method: 'POST',
      body: { name: teamName },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.team.name, 'samagra');
    assert.equal(res.data.team.ownerEmail, primaryEmail.toLowerCase());
    assert.equal(res.data.team.ownerId, primary.user.id);
    assert.equal(res.data.team.members[0].role, 'owner');
    teamId = res.data.team.id;
  });

  // 2. Account Sync: Inviting collaborator and linking account
  await t.test('4. Primary invites collaborator secondary Google account via email', async () => {
    const res = await primary.request(`/api/teams/${teamId}/members`, {
      method: 'POST',
      body: { email: secondaryEmail },
    });
    assert.equal(res.status, 201);
    assert.ok(res.data.team.members.some((m) => m.email === secondaryEmail.toLowerCase()));
  });

  await t.test('5. Secondary account logs in / registers and database user lookup properly recognizes and links workspace access', async () => {
    // Secondary registers after invitation
    const res = await secondary.request('/api/auth/register', {
      method: 'POST',
      body: { email: secondaryEmail, password },
    });
    assert.equal(res.status, 201);
    secondary.user = res.data.user;

    // Verify secondary account gains access to "samagra" workspace
    const teamsRes = await secondary.request('/api/teams');
    assert.equal(teamsRes.status, 200);
    assert.equal(teamsRes.data.teams.length, 1);
    assert.equal(teamsRes.data.teams[0].id, teamId);
    assert.equal(teamsRes.data.teams[0].name, 'samagra');
    // Account sync linked userId
    const memberRecord = teamsRes.data.teams[0].members.find(
      (m) => m.email === secondaryEmail.toLowerCase(),
    );
    assert.equal(memberRecord.userId, secondary.user.id);
  });

  // 3. Task Delegation & Deadlines
  await t.test('6. Create team task ("Editing the videos"), assigned directly to collaborator, deadline Sept 25 at 7:00 PM', async () => {
    const res = await primary.request('/api/tasks', {
      method: 'POST',
      body: {
        text: 'Editing the videos',
        teamId,
        assigneeEmail: secondaryEmail,
        dueAt: deadlineSept25,
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.task.text, 'Editing the videos');
    assert.equal(res.data.task.assigneeEmail, secondaryEmail.toLowerCase());
    assert.equal(res.data.task.creatorEmail, primaryEmail.toLowerCase());
    assert.equal(res.data.task.dueAt, deadlineSept25);
    assert.equal(res.data.task.progress, 0);
    taskId = res.data.task.id;
  });

  // 4. Real-time Concurrent Session Sync Verification
  await t.test('7. Secondary session monitors and sees "Editing the videos" with deadline and assignment', async () => {
    const res = await secondary.request(`/api/tasks?teamId=${teamId}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.tasks.length, 1);
    const task = res.data.tasks[0];
    assert.equal(task.id, taskId);
    assert.equal(task.text, 'Editing the videos');
    assert.equal(task.assigneeEmail, secondaryEmail.toLowerCase());
    assert.equal(task.dueAt, deadlineSept25);
    assert.equal(task.progress, 0);
  });

  await t.test('8. Secondary updates progress to 50% and posts comment/milestone update', async () => {
    // Secondary posts milestone comment
    const msRes = await secondary.request(`/api/tasks/${taskId}/milestones`, {
      method: 'POST',
      body: { text: 'Rough cut imported and sync checked', progress: 50 },
    });
    assert.equal(msRes.status, 201);
    assert.equal(msRes.data.task.progress, 50);
    assert.equal(msRes.data.task.milestones.length, 1);
    assert.equal(msRes.data.task.milestones[0].text, 'Rough cut imported and sync checked');
  });

  await t.test('9. Primary concurrent session instantly reflects 50% progress and new milestone comment', async () => {
    const res = await primary.request(`/api/tasks?teamId=${teamId}`);
    assert.equal(res.status, 200);
    const task = res.data.tasks.find((t) => t.id === taskId);
    assert.ok(task);
    assert.equal(task.progress, 50);
    assert.equal(task.milestones.length, 1);
    assert.equal(task.milestones[0].text, 'Rough cut imported and sync checked');
    assert.equal(task.milestones[0].progress, 50);
  });

  await t.test('10. Secondary marks task complete (100%), synced across both screens', async () => {
    const patchRes = await secondary.request(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: { done: true },
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.data.task.done, true);
    assert.equal(patchRes.data.task.progress, 100);
    assert.ok(patchRes.data.task.completedAt);

    // Primary verifies completed state
    const primaryCheck = await primary.request(`/api/tasks/${taskId}`);
    assert.equal(primaryCheck.status, 200);
    assert.equal(primaryCheck.data.task.done, true);
    assert.equal(primaryCheck.data.task.progress, 100);
  });

  await t.test('11. Strict privacy separation: Secondary cannot see Primary private personal tasks', async () => {
    // Secondary personal tasks are empty
    const secPersonal = await secondary.request('/api/tasks');
    assert.equal(secPersonal.status, 200);
    assert.equal(secPersonal.data.tasks.length, 0);

    // Secondary direct access to primary personal task returns 404
    const directAccess = await secondary.request(`/api/tasks/${primaryPersonalTaskId}`);
    assert.equal(directAccess.status, 404);

    // Primary personal tasks still contain their personal note
    const priPersonal = await primary.request('/api/tasks');
    assert.equal(priPersonal.status, 200);
    assert.equal(priPersonal.data.tasks.length, 1);
    assert.equal(priPersonal.data.tasks[0].id, primaryPersonalTaskId);
  });
});
