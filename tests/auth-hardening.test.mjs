import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InviteStore } from '../server/invites.ts';
import { RateLimiter } from '../server/rateLimit.ts';

const API_BASE = process.env.API_BASE || 'http://localhost:3001';

class TestClient {
  constructor() {
    this.cookies = '';
  }

  async request(pathname, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(this.cookies ? { Cookie: this.cookies } : {}),
      ...(options.headers || {}),
    };

    const res = await fetch(`${API_BASE}${pathname}`, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const match = setCookie.match(/todo_session=[^;]+/);
      if (match) this.cookies = match[0];
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    return { status: res.status, headers: res.headers, data };
  }
}

test('RateLimiter blocks after the limit and recovers after the window', () => {
  const limiter = new RateLimiter();
  const start = 1_000_000;
  assert.equal(limiter.consume('k', 2, 1000, start).allowed, true);
  assert.equal(limiter.consume('k', 2, 1000, start + 10).allowed, true);
  const blocked = limiter.consume('k', 2, 1000, start + 20);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  assert.equal(limiter.consume('k', 2, 1000, start + 1001).allowed, true);
});

test('InviteStore enforces uses, email binding, expiry, and release', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-invites-'));
  try {
    const store = new InviteStore(path.join(dir, 'invites.json'));
    await store.init();

    const created = await store.create({
      email: 'Beta@Example.com',
      maxUses: 1,
      expiresInDays: 1,
    });
    assert.equal(created.invite.email, 'beta@example.com');
    assert.equal(created.invite.maxUses, 1);

    const mismatch = await store.consume(created.code, 'other@example.com');
    assert.deepEqual(mismatch, { ok: false, reason: 'email_mismatch' });

    const used = await store.consume(created.code, 'beta@example.com');
    assert.equal(used.ok, true);
    assert.equal(used.invite.usedCount, 1);

    const exhausted = await store.consume(created.code, 'beta@example.com');
    assert.deepEqual(exhausted, { ok: false, reason: 'exhausted' });

    assert.equal(await store.release(created.code), true);
    const reused = await store.consume(created.code, 'beta@example.com');
    assert.equal(reused.ok, true);

    const revoked = await store.create({ maxUses: 3, expiresInDays: 1 });
    assert.equal(await store.revoke(revoked.invite.id), true);
    const afterRevoke = await store.consume(revoked.code, 'anyone@example.com');
    assert.deepEqual(afterRevoke, { ok: false, reason: 'revoked' });

    const expired = await store.create({ maxUses: 1, expiresInDays: 0 });
    const afterExpiry = await store.consume(expired.code, 'anyone@example.com');
    assert.deepEqual(afterExpiry, { ok: false, reason: 'expired' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Account security API - sessions, export, and deletion', async (t) => {
  const email = `security-${Date.now()}@example.com`;
  const password = 'SecurePassword123!';
  const primary = new TestClient();
  const secondary = new TestClient();
  let secondSessionId = null;

  await t.test('registers and creates a task', async () => {
    const registered = await primary.request('/api/auth/register', {
      method: 'POST',
      body: { email, password },
    });
    assert.equal(registered.status, 201);

    const created = await primary.request('/api/tasks', {
      method: 'POST',
      body: { text: 'Export me', dueAt: null },
    });
    assert.equal(created.status, 201);
  });

  await t.test('lists sessions with exactly one current device', async () => {
    const sessions = await primary.request('/api/auth/sessions');
    assert.equal(sessions.status, 200);
    assert.equal(sessions.data.sessions.length, 1);
    assert.equal(sessions.data.sessions[0].current, true);
    assert.ok(sessions.data.sessions[0].userAgent);
  });

  await t.test('a second login is visible and can be revoked', async () => {
    const login = await secondary.request('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    assert.equal(login.status, 200);

    const sessions = await primary.request('/api/auth/sessions');
    assert.equal(sessions.data.sessions.length, 2);
    const other = sessions.data.sessions.find((session) => !session.current);
    assert.ok(other);
    secondSessionId = other.id;

    const revoked = await primary.request(
      `/api/auth/sessions/${encodeURIComponent(secondSessionId)}`,
      { method: 'DELETE' },
    );
    assert.equal(revoked.status, 204);

    const me = await secondary.request('/api/auth/me');
    assert.equal(me.status, 401);
  });

  await t.test('revoke-others keeps the current session', async () => {
    const login = await secondary.request('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    assert.equal(login.status, 200);

    const result = await primary.request('/api/auth/sessions/revoke-others', {
      method: 'POST',
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.revoked, 1);

    const sessions = await primary.request('/api/auth/sessions');
    assert.equal(sessions.data.sessions.length, 1);
    assert.equal(sessions.data.sessions[0].current, true);

    const me = await secondary.request('/api/auth/me');
    assert.equal(me.status, 401);
  });

  await t.test('exports account data as JSON', async () => {
    const exported = await primary.request('/api/account/export');
    assert.equal(exported.status, 200);
    assert.equal(exported.data.user.email, email);
    assert.ok(Array.isArray(exported.data.tasks));
    assert.ok(exported.data.tasks.some((task) => task.text === 'Export me'));
    assert.ok(exported.data.timeMachine);
  });

  await t.test('rejects account deletion with a wrong password', async () => {
    const deleted = await primary.request('/api/account', {
      method: 'DELETE',
      body: { password: 'wrong-password' },
    });
    assert.equal(deleted.status, 401);
    const me = await primary.request('/api/auth/me');
    assert.equal(me.status, 200);
  });

  await t.test('deletes the account and revokes the session', async () => {
    const deleted = await primary.request('/api/account', {
      method: 'DELETE',
      body: { password },
    });
    assert.equal(deleted.status, 204);

    const me = await primary.request('/api/auth/me');
    assert.equal(me.status, 401);

    const login = await secondary.request('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    assert.equal(login.status, 401);
  });
});
