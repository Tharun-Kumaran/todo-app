import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalRrule,
  describeRrule,
  nextOccurrence,
  parseRrule,
} from '../shared/recurrence.ts';
import { detectRecurringPatterns } from '../server/recurrence.ts';
import {
  createSeries,
  runSeriesMaintenance,
  skipSeriesOccurrence,
  updateSeriesForUser,
} from '../server/recurrenceService.ts';

const DAY = 86_400_000;
const BASE = new Date('2026-09-01T09:00:00.000Z');

function iso(offsetDays) {
  return new Date(BASE.getTime() + offsetDays * DAY).toISOString();
}

function task(overrides = {}) {
  return {
    id: overrides.id ?? `task-${Math.random().toString(36).slice(2)}`,
    userId: 'user-1',
    creatorEmail: 'person@example.com',
    teamId: null,
    assigneeEmail: null,
    text: 'Weekly review',
    done: true,
    createdAt: iso(0),
    updatedAt: iso(0),
    completedAt: iso(0),
    dueAt: null,
    priority: 'Medium',
    category: null,
    scheduledStartAt: null,
    reminderAt: null,
    version: 1,
    progress: 100,
    milestones: [],
    source: 'manual',
    seriesId: null,
    occurrenceAt: null,
    ...overrides,
  };
}

/** In-memory TimeMachineStore stand-in with just the series operations. */
function fakeDeps(series = [], tasks = []) {
  const state = series.map((entry) => ({ ...entry }));
  const taskRows = [...tasks];

  return {
    tasks: {
      async listFor() {
        return taskRows.filter((row) => !row.deleted);
      },
      async hasOccurrence(seriesId, occurrenceAt) {
        return taskRows.some(
          (row) =>
            row.seriesId === seriesId && row.occurrenceAt === occurrenceAt,
        );
      },
      async addRecurring(userId, creatorEmail, title, dueAt, seriesId) {
        const next = task({
          userId,
          creatorEmail,
          text: title,
          done: false,
          completedAt: null,
          dueAt,
          version: 1,
          progress: 0,
          source: 'recurrence',
          seriesId,
          occurrenceAt: dueAt,
        });
        taskRows.push(next);
        return next;
      },
      async remove(_userId, id) {
        const found = taskRows.find((row) => row.id === id);
        if (found) found.deleted = true;
        return Boolean(found);
      },
    },
    timeMachine: {
      listSeries(userId) {
        return state.filter((entry) => entry.userId === userId).map((e) => ({ ...e }));
      },
      getSeries(userId, id) {
        const found = state.find(
          (entry) => entry.userId === userId && entry.id === id,
        );
        return found ? { ...found } : null;
      },
      async upsertSeries(entry) {
        const index = state.findIndex((existing) => existing.id === entry.id);
        if (index === -1) state.push({ ...entry });
        else state[index] = { ...entry };
        return { ...entry };
      },
      async updateSeries(userId, id, patch) {
        const found = state.find(
          (entry) => entry.userId === userId && entry.id === id,
        );
        if (!found) return null;
        Object.assign(found, patch, { updatedAt: new Date().toISOString() });
        return { ...found };
      },
    },
    series: state,
    taskRows,
  };
}

test('RRULE helpers accept the supported subset only', () => {
  assert.deepEqual(parseRrule('FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2'), {
    freq: 'WEEKLY',
    interval: 2,
    byDay: [1, 3],
  });
  assert.equal(parseRrule('FREQ=HOURLY'), null);
  assert.equal(parseRrule('FREQ=WEEKLY;BYDAY=XX'), null);
  assert.equal(parseRrule('FREQ=MONTHLY;BYDAY=MO'), null);

  assert.equal(canonicalRrule('freq=weekly;byday=we,mo'), 'FREQ=WEEKLY;BYDAY=MO,WE');
  assert.equal(describeRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'), 'every two weeks on Monday');
  assert.equal(describeRrule('FREQ=DAILY'), 'every day');

  const next = nextOccurrence('FREQ=WEEKLY;BYDAY=MO', new Date('2026-09-01T09:00:00Z'));
  assert.equal(next.toISOString(), '2026-09-07T09:00:00.000Z');
});

test('detection needs three regular personal completions', () => {
  const weekly = [
    task({ completedAt: iso(0) }),
    task({ completedAt: iso(7) }),
    task({ completedAt: iso(14) }),
  ];
  const [pattern] = detectRecurringPatterns(weekly);
  assert.ok(pattern);
  assert.equal(pattern.rrule, 'FREQ=WEEKLY;BYDAY=TU');
  assert.equal(pattern.sampleCount, 3);
  assert.equal(pattern.nextAt, iso(21).replace('T09:00:00.000Z', 'T09:00:00.000Z'));

  assert.deepEqual(
    detectRecurringPatterns([
      task({ completedAt: iso(0) }),
      task({ completedAt: iso(7) }),
    ]),
    [],
    'two completions are not a pattern',
  );

  assert.deepEqual(
    detectRecurringPatterns([
      task({ completedAt: iso(0) }),
      task({ completedAt: iso(2) }),
      task({ completedAt: iso(11) }),
    ]),
    [],
    'irregular intervals are not a pattern',
  );

  assert.deepEqual(
    detectRecurringPatterns([
      task({ completedAt: iso(0) }),
      task({ completedAt: iso(7) }),
      task({ completedAt: iso(14), teamId: 'team-1' }),
    ]),
    [],
    'team tasks do not participate',
  );
});

test('maintenance suggests a series without creating tasks', async () => {
  const tasks = [
    task({ completedAt: iso(0) }),
    task({ completedAt: iso(7) }),
    task({ completedAt: iso(14) }),
  ];
  const deps = fakeDeps([], tasks);
  const now = new Date(iso(15));

  const series = await runSeriesMaintenance({
    deps,
    userId: 'user-1',
    tasks,
    now,
    force: true,
  });

  assert.equal(series.length, 1);
  assert.equal(series[0].status, 'suggested');
  assert.equal(series[0].autoCreate, false);
  assert.equal(series[0].sampleCount, 3);
  assert.equal(deps.taskRows.length, tasks.length, 'no task is auto-created');
});

test('opted-in series create one occurrence and never duplicate it', async () => {
  const tasks = [
    task({ completedAt: iso(0) }),
    task({ completedAt: iso(7) }),
    task({ completedAt: iso(14) }),
  ];
  const deps = fakeDeps([], tasks);

  await runSeriesMaintenance({
    deps,
    userId: 'user-1',
    tasks,
    now: new Date(iso(15)),
    force: true,
  });
  const [suggestion] = deps.series;

  const activated = await updateSeriesForUser({
    deps,
    userId: 'user-1',
    id: suggestion.id,
    patch: { status: 'active', autoCreate: true },
    now: new Date(iso(15)),
  });
  assert.equal(activated.status, 'active');
  assert.equal(activated.autoCreate, true);
  assert.equal(activated.nextAt, iso(21), 'resuming picks the next future slot');

  await runSeriesMaintenance({
    deps,
    userId: 'user-1',
    tasks,
    now: new Date(iso(22)),
    force: true,
  });
  const created = deps.taskRows.filter((row) => row.source === 'recurrence');
  assert.equal(created.length, 1);
  assert.equal(created[0].seriesId, suggestion.id);
  assert.equal(created[0].occurrenceAt, iso(21));
  assert.equal(created[0].done, false);

  await runSeriesMaintenance({
    deps,
    userId: 'user-1',
    tasks,
    now: new Date(iso(22)),
    force: true,
  });
  assert.equal(
    deps.taskRows.filter((row) => row.source === 'recurrence').length,
    1,
    'an open occurrence blocks a second task',
  );

  const done = { ...created[0], done: true, completedAt: iso(22) };
  deps.taskRows.splice(deps.taskRows.indexOf(created[0]), 1, done);
  await runSeriesMaintenance({
    deps,
    userId: 'user-1',
    tasks,
    now: new Date(iso(22)),
    force: true,
  });
  const afterCompletion = deps.taskRows.filter(
    (row) => row.source === 'recurrence',
  );
  assert.equal(afterCompletion.length, 2);
  assert.equal(afterCompletion[1].occurrenceAt, iso(28));
});

test('skip deletes the open occurrence and moves the schedule forward', async () => {
  const deps = fakeDeps(
    [
      {
        id: 'series-1',
        userId: 'user-1',
        title: 'Weekly review',
        rrule: 'FREQ=WEEKLY;BYDAY=TU',
        timezone: 'UTC',
        autoCreate: true,
        status: 'active',
        nextAt: iso(7),
        createdAt: iso(0),
        updatedAt: iso(0),
      },
    ],
    [
      task({
        text: 'Weekly review',
        done: false,
        completedAt: null,
        dueAt: iso(7),
        source: 'recurrence',
        seriesId: 'series-1',
        occurrenceAt: iso(7),
      }),
    ],
  );

  const series = await skipSeriesOccurrence({
    deps,
    userId: 'user-1',
    id: 'series-1',
    tasks: await deps.tasks.listFor(),
    now: new Date(iso(8)),
  });

  assert.ok(deps.taskRows[0].deleted, 'the open generated task is removed');
  assert.equal(series.nextAt, iso(14));
});

test('ending a series clears its schedule', async () => {
  const deps = fakeDeps([
    {
      id: 'series-1',
      userId: 'user-1',
      title: 'Weekly review',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      timezone: 'UTC',
      autoCreate: true,
      status: 'active',
      nextAt: iso(7),
      createdAt: iso(0),
      updatedAt: iso(0),
    },
  ]);

  const ended = await updateSeriesForUser({
    deps,
    userId: 'user-1',
    id: 'series-1',
    patch: { status: 'ended' },
    now: new Date(iso(8)),
  });
  assert.equal(ended.status, 'ended');
  assert.equal(ended.nextAt, null);

  await runSeriesMaintenance({
    deps,
    userId: 'user-1',
    tasks: [],
    now: new Date(iso(30)),
    force: true,
  });
  assert.equal(deps.taskRows.length, 0);
});

test('createSeries rejects a duplicate title for the same user', async () => {
  const deps = fakeDeps();
  const first = await createSeries({
    deps,
    userId: 'user-1',
    title: 'Weekly review',
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    now: BASE,
  });
  assert.ok(first);
  assert.equal(first.autoCreate, false, 'auto-create is opt-in');

  const duplicate = await createSeries({
    deps,
    userId: 'user-1',
    title: 'weekly REVIEW',
    rrule: 'FREQ=WEEKLY;BYDAY=TU',
    now: BASE,
  });
  assert.equal(duplicate, null);
  assert.equal(deps.series.length, 1);
});

test('series API requires a session and defaults auto-create off', async (t) => {
  const base = process.env.API_BASE || 'http://localhost:3001';
  let cookie = '';

  async function request(path, options = {}) {
    const res = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(options.headers ?? {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const match = setCookie.match(/todo_session=[^;]+/);
      if (match) cookie = match[0];
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      // Empty body.
    }
    return { status: res.status, data };
  }

  await t.test('rejects anonymous access', async () => {
    const res = await request('/api/series');
    assert.equal(res.status, 401);
  });

  await t.test('registers a user', async () => {
    const res = await request('/api/auth/register', {
      method: 'POST',
      body: {
        email: `recurrence-${Date.now()}@example.com`,
        password: 'SecurePassword123!',
      },
    });
    assert.equal(res.status, 201);
  });

  let seriesId = null;

  await t.test('creates a series with auto-create off', async () => {
    const res = await request('/api/series', {
      method: 'POST',
      body: { title: 'Water the plants', rrule: 'FREQ=WEEKLY;BYDAY=SA' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.series.status, 'active');
    assert.equal(res.data.series.autoCreate, false);
    assert.equal(res.data.series.rrule, 'FREQ=WEEKLY;BYDAY=SA');
    assert.ok(res.data.series.nextAt);
    seriesId = res.data.series.id;
  });

  await t.test('rejects a duplicate title and invalid rules', async () => {
    const duplicate = await request('/api/series', {
      method: 'POST',
      body: { title: 'water the PLANTS', rrule: 'FREQ=WEEKLY' },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, 'SERIES_TITLE_TAKEN');

    const invalid = await request('/api/series', {
      method: 'POST',
      body: { title: 'Hourly standup', rrule: 'FREQ=HOURLY' },
    });
    assert.equal(invalid.status, 400);
  });

  await t.test('opts in, pauses, skips, and ends', async () => {
    const optedIn = await request(`/api/series/${seriesId}`, {
      method: 'PATCH',
      body: { autoCreate: true },
    });
    assert.equal(optedIn.status, 200);
    assert.equal(optedIn.data.series.autoCreate, true);

    const skipped = await request(`/api/series/${seriesId}/skip`, {
      method: 'POST',
    });
    assert.equal(skipped.status, 200);

    const paused = await request(`/api/series/${seriesId}`, {
      method: 'PATCH',
      body: { status: 'paused' },
    });
    assert.equal(paused.status, 200);
    assert.equal(paused.data.series.status, 'paused');

    const resumed = await request(`/api/series/${seriesId}`, {
      method: 'PATCH',
      body: { status: 'active' },
    });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.data.series.status, 'active');
    assert.ok(resumed.data.series.nextAt);

    const ended = await request(`/api/series/${seriesId}`, {
      method: 'PATCH',
      body: { status: 'ended' },
    });
    assert.equal(ended.status, 200);
    assert.equal(ended.data.series.nextAt, null);

    const listed = await request('/api/series');
    assert.equal(listed.status, 200);
    assert.equal(listed.data.series.length, 1);
  });

  await t.test('materializing is idempotent', async () => {
    const first = await request('/api/series/materialize', { method: 'POST' });
    assert.equal(first.status, 200);
    const second = await request('/api/series/materialize', { method: 'POST' });
    assert.equal(second.status, 200);
    assert.equal(
      second.data.tasks.filter((task) => task.seriesId).length,
      first.data.tasks.filter((task) => task.seriesId).length,
    );
  });
});
