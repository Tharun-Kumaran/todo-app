import test from 'node:test';
import assert from 'node:assert/strict';

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
      const match = setCookie.match(/todo_session=[^;]*/);
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

function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

const PASSWORD = 'SecurePassword123!';

async function register(client, email, password = PASSWORD) {
  const result = await client.request('/api/auth/register', {
    method: 'POST',
    body: { email, password },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.user;
}

test('Settings API - defaults, validation, and updates', async (t) => {
  const client = new TestClient();

  await t.test('registers a user with private-by-default settings', async () => {
    await register(client, uniqueEmail('settings'));
    const settings = await client.request('/api/settings');
    assert.equal(settings.status, 200);
    assert.equal(settings.data.settings.predictionEnabled, true);
    assert.equal(settings.data.settings.recommendationsEnabled, true);
    assert.equal(settings.data.settings.sharedLearningOptIn, false);
    assert.equal(settings.data.settings.llmOptIn, false);
    assert.equal(settings.data.settings.recurrenceAutoCreateDefault, false);
    assert.equal(settings.data.settings.emailRemindersEnabled, false);
    assert.equal(settings.data.settings.timezone, 'UTC');
  });

  await t.test('updates booleans, timezone, and locale', async () => {
    const updated = await client.request('/api/settings', {
      method: 'PATCH',
      body: {
        sharedLearningOptIn: true,
        llmOptIn: true,
        recurrenceAutoCreateDefault: true,
        recommendationsEnabled: false,
        emailRemindersEnabled: true,
        timezone: 'Europe/London',
        locale: 'en-GB',
      },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.settings.sharedLearningOptIn, true);
    assert.equal(updated.data.settings.llmOptIn, true);
    assert.equal(updated.data.settings.recurrenceAutoCreateDefault, true);
    assert.equal(updated.data.settings.recommendationsEnabled, false);
    assert.equal(updated.data.settings.emailRemindersEnabled, true);
    assert.equal(updated.data.settings.timezone, 'Europe/London');
    assert.equal(updated.data.settings.locale, 'en-GB');

    const reread = await client.request('/api/settings');
    assert.equal(reread.data.settings.timezone, 'Europe/London');
  });

  await t.test('rejects invalid values', async () => {
    const badTimezone = await client.request('/api/settings', {
      method: 'PATCH',
      body: { timezone: 'Mars/Olympus' },
    });
    assert.equal(badTimezone.status, 400);

    const badType = await client.request('/api/settings', {
      method: 'PATCH',
      body: { llmOptIn: 'yes' },
    });
    assert.equal(badType.status, 400);

    const unknown = await client.request('/api/settings', {
      method: 'PATCH',
      body: { allowEverything: true },
    });
    assert.equal(unknown.status, 400);

    const empty = await client.request('/api/settings', {
      method: 'PATCH',
      body: {},
    });
    assert.equal(empty.status, 400);
  });
});

test('Email verification API - single use tokens', async (t) => {
  const client = new TestClient();
  let token = null;

  await t.test('registers an unverified account', async () => {
    const user = await register(client, uniqueEmail('verify'));
    assert.equal(user.emailVerifiedAt, null);

    const me = await client.request('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.user.emailVerifiedAt, null);
  });

  await t.test('issues a development token in test mode', async () => {
    const sent = await client.request('/api/auth/email/verification', {
      method: 'POST',
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.data.sent, true);
    assert.ok(sent.data.devToken, 'tests need the token without a mail server');
    token = sent.data.devToken;
  });

  await t.test('verifies the email and marks it on the user', async () => {
    const verified = await client.request('/api/auth/email/verify', {
      method: 'POST',
      body: { token },
    });
    assert.equal(verified.status, 200);
    assert.ok(verified.data.user.emailVerifiedAt);

    const me = await client.request('/api/auth/me');
    assert.ok(me.data.user.emailVerifiedAt);
  });

  await t.test('refuses to reuse the verification token', async () => {
    const reused = await client.request('/api/auth/email/verify', {
      method: 'POST',
      body: { token },
    });
    assert.equal(reused.status, 400);
    assert.equal(reused.data.code, 'INVALID_OR_EXPIRED_TOKEN');
  });
});

test('Password reset API - revokes sessions and rotates the password', async (t) => {
  const email = uniqueEmail('reset');
  const client = new TestClient();
  let token = null;

  await t.test('registers and requests a reset', async () => {
    await register(client, email);
    const sent = await client.request('/api/auth/password/forgot', {
      method: 'POST',
      body: { email },
    });
    assert.equal(sent.status, 200);
    assert.ok(sent.data.devToken);
    token = sent.data.devToken;
  });

  await t.test('does not reveal unknown accounts', async () => {
    const sent = await client.request('/api/auth/password/forgot', {
      method: 'POST',
      body: { email: uniqueEmail('missing') },
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.data.sent, true);
    assert.equal(sent.data.devToken, undefined);
  });

  await t.test('resets the password and signs out existing sessions', async () => {
    const newPassword = 'AnEvenBetterPassword456!';
    const reset = await client.request('/api/auth/password/reset', {
      method: 'POST',
      body: { token, password: newPassword },
    });
    assert.equal(reset.status, 204);

    const me = await client.request('/api/auth/me');
    assert.equal(me.status, 401, 'the old session was revoked');

    const oldLogin = await new TestClient().request('/api/auth/login', {
      method: 'POST',
      body: { email, password: PASSWORD },
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await new TestClient().request('/api/auth/login', {
      method: 'POST',
      body: { email, password: newPassword },
    });
    assert.equal(newLogin.status, 200);
  });

  await t.test('refuses to reuse the reset token', async () => {
    const reused = await client.request('/api/auth/password/reset', {
      method: 'POST',
      body: { token, password: 'AnotherPassword789!' },
    });
    assert.equal(reused.status, 400);
    assert.equal(reused.data.code, 'INVALID_OR_EXPIRED_TOKEN');
  });
});

test('Recurring series API - create, update, skip, and isolation', async (t) => {
  const owner = new TestClient();
  const other = new TestClient();
  let seriesId = null;

  await t.test('registers two separate accounts', async () => {
    await register(owner, uniqueEmail('series-owner'));
    await register(other, uniqueEmail('series-other'));
  });

  await t.test('creates a series with auto-create off by default', async () => {
    const created = await owner.request('/api/series', {
      method: 'POST',
      body: { title: 'Weekly review', rrule: 'freq=weekly;byday=mo' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.series.status, 'active');
    assert.equal(created.data.series.autoCreate, false);
    assert.equal(created.data.series.rrule, 'FREQ=WEEKLY;BYDAY=MO');
    seriesId = created.data.series.id;
  });

  await t.test('rejects invalid rules and duplicate titles', async () => {
    const invalid = await owner.request('/api/series', {
      method: 'POST',
      body: { title: 'Bad rule', rrule: 'FREQ=HOURLY' },
    });
    assert.equal(invalid.status, 400);

    const duplicate = await owner.request('/api/series', {
      method: 'POST',
      body: { title: 'weekly REVIEW', rrule: 'FREQ=WEEKLY;BYDAY=TU' },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, 'SERIES_TITLE_TAKEN');
  });

  await t.test('lists only the owner series', async () => {
    const mine = await owner.request('/api/series');
    assert.equal(mine.status, 200);
    assert.ok(mine.data.series.some((entry) => entry.id === seriesId));

    const theirs = await other.request('/api/series');
    assert.equal(theirs.status, 200);
    assert.deepEqual(theirs.data.series, []);
  });

  await t.test('toggles auto-create and pauses the series', async () => {
    const enabled = await owner.request(
      `/api/series/${encodeURIComponent(seriesId)}`,
      { method: 'PATCH', body: { autoCreate: true } },
    );
    assert.equal(enabled.status, 200);
    assert.equal(enabled.data.series.autoCreate, true);

    const paused = await owner.request(
      `/api/series/${encodeURIComponent(seriesId)}`,
      { method: 'PATCH', body: { status: 'paused' } },
    );
    assert.equal(paused.status, 200);
    assert.equal(paused.data.series.status, 'paused');

    const invalid = await owner.request(
      `/api/series/${encodeURIComponent(seriesId)}`,
      { method: 'PATCH', body: { status: 'sometimes' } },
    );
    assert.equal(invalid.status, 400);
  });

  await t.test('other users cannot change the series', async () => {
    const attempt = await other.request(
      `/api/series/${encodeURIComponent(seriesId)}`,
      { method: 'PATCH', body: { autoCreate: true } },
    );
    assert.equal(attempt.status, 404);
  });

  await t.test('skips the next occurrence', async () => {
    const skipped = await owner.request(
      `/api/series/${encodeURIComponent(seriesId)}/skip`,
      { method: 'POST' },
    );
    assert.equal(skipped.status, 200);
    assert.ok(skipped.data.series.nextAt);
  });

  await t.test('materializes due tasks on demand', async () => {
    const result = await owner.request('/api/series/materialize', {
      method: 'POST',
    });
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.data.series));
    assert.ok(Array.isArray(result.data.tasks));
  });
});
