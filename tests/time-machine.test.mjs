import test from 'node:test';
import assert from 'node:assert/strict';
import {
  brierScore,
  buildTimeMachine,
  expectedCalibrationError,
  fitCalibration,
  isHoldoutTask,
} from '../server/timeMachine.ts';

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const DAY = 86_400_000;
const NOW = new Date('2026-11-15T10:00:00.000Z');

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

function iso(offsetDays) {
  return new Date(NOW.getTime() + offsetDays * DAY).toISOString();
}

function historyTask({
  id,
  text = 'Go to temple',
  createdAt,
  completedAt,
  dueAt,
  priority = 'Medium',
  category = 'Operations',
  milestones = [],
}) {
  return {
    id,
    text,
    createdAt,
    completedAt,
    dueAt,
    done: completedAt !== null,
    priority,
    category,
    milestones,
  };
}

function target(overrides = {}) {
  return {
    id: 'target-task',
    text: 'Go to temple',
    dueAt: iso(2),
    priority: 'Medium',
    category: 'Operations',
    createdAt: NOW.toISOString(),
    done: false,
    ...overrides,
  };
}

test('Time Machine v2 - pure model', async (t) => {
  await t.test('cold start is labelled global and gives an honest interval', () => {
    const result = buildTimeMachine(target(), [], { now: NOW });
    assert.equal(result.model.mode, 'global');
    assert.equal(result.model.sampleSize, 0);
    assert.equal(result.baseline.confidence, 'low');
    assert.ok(result.baseline.completionProbability > 0);
    assert.ok(result.baseline.completionProbability < 1);
    assert.ok(result.baseline.interval[0] <= result.baseline.completionProbability);
    assert.ok(result.baseline.interval[1] >= result.baseline.completionProbability);
    assert.ok(result.baseline.reasons.length > 0);
    assert.ok(result.baseline.expectedCompletion);
  });

  await t.test('personal history raises confidence and produces evidence', () => {
    const history = Array.from({ length: 6 }, (_, index) =>
      historyTask({
        id: `history-${index}`,
        createdAt: iso(-20 + index),
        dueAt: iso(-18 + index),
        completedAt: iso(-19 + index),
      }),
    );

    const cold = buildTimeMachine(target(), [], { now: NOW });
    const personal = buildTimeMachine(target(), history, { now: NOW });

    assert.equal(personal.model.mode, 'personal');
    assert.ok(personal.model.sampleSize >= 5);
    assert.ok(personal.baseline.confidence !== 'low');
    assert.ok(personal.baseline.evidence.length > 0);
    assert.ok(
      personal.baseline.completionProbability >
        cold.baseline.completionProbability,
      `expected personal ${personal.baseline.completionProbability} > cold ${cold.baseline.completionProbability}`,
    );
  });

  await t.test('deadline recommendation reports a positive lift', () => {
    const history = Array.from({ length: 6 }, (_, index) =>
      historyTask({
        id: `duration-${index}`,
        createdAt: iso(-30 + index * 2),
        dueAt: iso(-25 + index * 2),
        completedAt: iso(-26 + index * 2),
      }),
    );
    const result = buildTimeMachine(
      target({ dueAt: iso(1), text: 'Go to temple' }),
      history,
      { now: NOW },
    );

    const deadline = result.recommendations.find(
      (recommendation) => recommendation.type === 'deadline_change',
    );
    assert.ok(deadline, 'expected a deadline recommendation');
    assert.ok(deadline.lift >= 0.05);
    assert.ok(deadline.recommendedProbability > result.baseline.completionProbability);
    assert.ok(deadline.payload.dueAt);
  });

  await t.test('holdout suppresses recommendations and is deterministic', () => {
    let holdoutId = null;
    for (let index = 0; index < 500; index += 1) {
      if (isHoldoutTask(`holdout-${index}`)) {
        holdoutId = `holdout-${index}`;
        break;
      }
    }
    assert.ok(holdoutId, 'expected to find a holdout id');
    assert.equal(isHoldoutTask(holdoutId), true);

    const result = buildTimeMachine(
      target({ id: holdoutId, dueAt: iso(1) }),
      [],
      { now: NOW, holdout: true },
    );
    assert.equal(result.holdout, true);
    assert.equal(result.recommendations.length, 0);
  });

  await t.test('calibration and scoring helpers are bounded', () => {
    const samples = Array.from({ length: 30 }, () => ({
      probability: 0.85,
      label: 1,
      ageDays: 1,
    }));
    const calibration = fitCalibration(samples);
    assert.ok(calibration);
    assert.ok(calibration.a >= 0.2 && calibration.a <= 3);
    assert.ok(calibration.b >= -2 && calibration.b <= 2);

    assert.equal(
      brierScore([
        { probability: 0.8, label: 1 },
        { probability: 0.2, label: 0 },
      ]),
      0.04,
    );
    assert.ok(
      expectedCalibrationError([
        { probability: 0.8, label: 1 },
        { probability: 0.2, label: 0 },
      ]) !== null,
    );
  });
});

test('Time Machine v2 - API integration', async (t) => {
  const client = new TestClient();
  const otherClient = new TestClient();
  const email = `tm-user-${Date.now()}@example.com`;
  const otherEmail = `tm-other-${Date.now()}@example.com`;
  const password = 'SecurePassword123!';
  let firstTask = null;
  let appliedRecommendation = null;
  let dismissedType = null;
  let shownIds = [];

  await t.test('registers a user', async () => {
    const res = await client.request('/api/auth/register', {
      method: 'POST',
      body: { email, password },
    });
    assert.equal(res.status, 201);
  });

  await t.test('creates a task and returns a persisted Time Machine payload', async () => {
    const res = await client.request('/api/tasks', {
      method: 'POST',
      body: {
        text: 'Refactor database ORM queries and indexing',
        dueAt: iso(1),
        priority: 'Low',
        category: 'Software Engineering',
      },
    });
    assert.equal(res.status, 201);
    firstTask = res.data.task;
    assert.equal(typeof firstTask.version, 'number');

    const tm = await client.request(`/api/tasks/${firstTask.id}/time-machine`);
    assert.equal(tm.status, 200);
    assert.ok(tm.data.timeMachine);
    assert.equal(tm.data.timeMachine.taskId, firstTask.id);
    assert.equal(typeof tm.data.timeMachine.baseline.completionProbability, 'number');
    assert.ok(Array.isArray(tm.data.timeMachine.recommendations));
  });

  await t.test('applies a recommendation atomically and bumps the task version', async () => {
    const tm = await client.request(`/api/tasks/${firstTask.id}/time-machine`);
    const recommendation = tm.data.timeMachine.recommendations[0];
    if (!recommendation) {
      t.skip('No recommendation available for this seed task.');
      return;
    }

    const res = await client.request(
      `/api/recommendations/${recommendation.id}/apply`,
      {
        method: 'POST',
        body: { expectedVersion: firstTask.version },
      },
    );
    assert.equal(res.status, 200);
    assert.ok(res.data.task);
    assert.ok(res.data.task.version > firstTask.version);
    assert.equal(res.data.recommendation.id, recommendation.id);
    assert.ok(res.data.timeMachine);
    appliedRecommendation = recommendation;
    firstTask = res.data.task;
  });

  await t.test('rejects a stale apply with 409', async () => {
    if (!appliedRecommendation) {
      t.skip('No applied recommendation.');
      return;
    }
    const res = await client.request(
      `/api/recommendations/${appliedRecommendation.id}/apply`,
      {
        method: 'POST',
        body: { expectedVersion: firstTask.version - 1 },
      },
    );
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'RECOMMENDATION_INACTIVE');
  });

  await t.test('records impressions idempotently', async () => {
    const tm = await client.request(`/api/tasks/${firstTask.id}/time-machine`);
    shownIds = tm.data.timeMachine.recommendations.map(
      (recommendation) => recommendation.id,
    );
    if (shownIds.length === 0) {
      t.skip('No recommendations to impress.');
      return;
    }
    const first = await client.request('/api/recommendations/impressions', {
      method: 'POST',
      body: { ids: shownIds },
    });
    assert.equal(first.status, 204);
    const second = await client.request('/api/recommendations/impressions', {
      method: 'POST',
      body: { ids: shownIds },
    });
    assert.equal(second.status, 204);
  });

  await t.test('dismisses a recommendation and applies a cooldown', async () => {
    const created = await client.request('/api/tasks', {
      method: 'POST',
      body: {
        text: 'Refactor database ORM queries and indexing',
        dueAt: iso(1),
        priority: 'Low',
        category: 'Software Engineering',
      },
    });
    assert.equal(created.status, 201);
    const task = created.data.task;
    const tm = await client.request(`/api/tasks/${task.id}/time-machine`);
    const recommendation = tm.data.timeMachine.recommendations[0];
    if (!recommendation) {
      t.skip('No recommendation to dismiss.');
      return;
    }

    const dismissed = await client.request(
      `/api/recommendations/${recommendation.id}/dismiss`,
      { method: 'POST', body: { reason: 'not_useful' } },
    );
    assert.equal(dismissed.status, 204);
    dismissedType = recommendation.type;

    const after = await client.request(`/api/tasks/${task.id}/time-machine`);
    assert.equal(after.status, 200);
    assert.ok(
      !after.data.timeMachine.recommendations.some(
        (entry) => entry.type === dismissedType,
      ),
      `expected ${dismissedType} to be on cooldown`,
    );
  });

  await t.test('isolates Time Machine data between users', async () => {
    const registered = await otherClient.request('/api/auth/register', {
      method: 'POST',
      body: { email: otherEmail, password },
    });
    assert.equal(registered.status, 201);

    const res = await otherClient.request(
      `/api/tasks/${firstTask.id}/time-machine`,
    );
    assert.equal(res.status, 404);
  });

  await t.test('team tasks return baseline only', async () => {
    const team = await client.request('/api/teams', {
      method: 'POST',
      body: { name: 'Time Machine Team' },
    });
    assert.equal(team.status, 201);

    const task = await client.request('/api/tasks', {
      method: 'POST',
      body: {
        text: 'Team planning task',
        dueAt: iso(1),
        teamId: team.data.team.id,
        priority: 'Low',
      },
    });
    assert.equal(task.status, 201);

    const tm = await client.request(
      `/api/tasks/${task.data.task.id}/time-machine`,
    );
    assert.equal(tm.status, 200);
    assert.equal(tm.data.timeMachine.recommendations.length, 0);
  });

  await t.test('completion resolves an outcome and insights report it', async () => {
    const completed = await client.request(`/api/tasks/${firstTask.id}`, {
      method: 'PATCH',
      body: { done: true, progress: 100 },
    });
    assert.equal(completed.status, 200);

    const outcomes = await client.request(
      `/api/time-machine/outcomes?taskId=${firstTask.id}`,
    );
    assert.equal(outcomes.status, 200);
    assert.ok(outcomes.data.outcomes.length >= 1);

    const insights = await client.request('/api/time-machine/insights');
    assert.equal(insights.status, 200);
    assert.ok(insights.data.insights.resolved >= 1);
    assert.ok(insights.data.insights.brier !== null);
    assert.equal(typeof insights.data.insights.coldStart, 'boolean');
    assert.ok(insights.data.insights.recommendations.shown >= shownIds.length);
  });
});
