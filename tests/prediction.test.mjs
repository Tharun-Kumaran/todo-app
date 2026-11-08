import test from 'node:test';
import assert from 'node:assert/strict';
import {
  predictTaskFeasibility,
  inferCategory,
  inferActionVerb,
} from '../server/prediction.ts';

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

test('Prediction Engine - Unit Tests', async (t) => {
  await t.test('inferCategory correctly identifies categories from keywords', () => {
    assert.equal(inferCategory('Fix database connection pool bug'), 'Software Engineering');
    assert.equal(inferCategory('Create Figma wireframe and landing page UX mockups'), 'Product Design');
    assert.equal(inferCategory('Setup Kubernetes Helm charts and CI/CD cluster pipeline'), 'DevOps & Infrastructure');
    assert.equal(inferCategory('Train PyTorch machine learning pipeline for model'), 'Data Engineering & AI');
    assert.equal(inferCategory('Automated selenium E2E regression tests'), 'Quality Assurance');
    assert.equal(inferCategory('Quarterly budget tax ledger audit'), 'Finance & Compliance');
  });

  await t.test('inferActionVerb detects action types and complexities', () => {
    assert.equal(inferActionVerb('Refactor auth session module'), 'Refactor');
    assert.equal(inferActionVerb('Fix typo in header'), 'Fix');
    assert.equal(inferActionVerb('Deploy docker cluster'), 'Deploy');
  });

  await t.test('predictTaskFeasibility flags aggressive low-priority deadlines as HIGH risk', () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const result = predictTaskFeasibility({
      text: 'Refactor entire distributed microservices architecture',
      dueAt: tomorrow,
      priority: 'Low',
    });

    assert.equal(result.riskLevel, 'HIGH');
    assert.ok(result.delayProbability >= 0.70, `Expected delayProbability >= 0.70, got ${result.delayProbability}`);
    assert.ok(result.predictedDurationDays >= 5);
    assert.ok(result.reasons.length > 0);

    // Verify recommendations
    const hasDeadlineRec = result.recommendations.some((r) => r.type === 'set_deadline');
    const hasPriorityRec = result.recommendations.some((r) => r.type === 'change_priority');
    assert.ok(hasDeadlineRec, 'Should recommend extending deadline');
    assert.ok(hasPriorityRec, 'Should recommend escalating priority');
  });

  await t.test('predictTaskFeasibility marks urgent tasks with reasonable lead time as LOW risk', () => {
    const inFiveDays = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const result = predictTaskFeasibility({
      text: 'Fix critical production login crash',
      dueAt: inFiveDays,
      priority: 'Urgent',
    });

    assert.equal(result.riskLevel, 'LOW');
    assert.ok(result.delayProbability <= 0.25, `Expected delayProbability <= 0.25, got ${result.delayProbability}`);
  });

  await t.test('Deadline shift penalty increases delay probability based on dataset findings', () => {
    const inTwelveDays = new Date(Date.now() + 12 * 86_400_000).toISOString();
    const noShift = predictTaskFeasibility({
      text: 'Analyze customer churn report',
      dueAt: inTwelveDays,
      priority: 'Medium',
      shiftCount: 0,
    });

    const shifted = predictTaskFeasibility({
      text: 'Analyze customer churn report',
      dueAt: inTwelveDays,
      priority: 'Medium',
      shiftCount: 2,
    });

    assert.ok(
      shifted.delayProbability > noShift.delayProbability,
      `Shifted task (${shifted.delayProbability}) should have higher delay probability than unshifted (${noShift.delayProbability})`,
    );
    assert.ok(
      shifted.reasons.some((r) => r.includes('shifted 2 times')),
      'Should mention shift reason in advisory notes',
    );
  });
});

test('Prediction Engine & Task Priority API - Integration Tests', async (t) => {
  const client = new TestClient();
  const testUser = `predict-user-${Date.now()}@example.com`;
  const password = 'SecurePassword123!';

  await t.test('Prediction endpoint rejects unauthenticated access', async () => {
    const unauthClient = new TestClient();
    const res = await unauthClient.request('/api/tasks/predict', {
      method: 'POST',
      body: { text: 'Test task' },
    });
    assert.equal(res.status, 401);
  });

  await t.test('Register and authenticate user for prediction', async () => {
    const res = await client.request('/api/auth/register', {
      method: 'POST',
      body: { email: testUser, password },
    });
    assert.equal(res.status, 201);
  });

  await t.test('POST /api/tasks/predict returns actionable analysis and suggestions', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const res = await client.request('/api/tasks/predict', {
      method: 'POST',
      body: {
        text: 'Refactor database ORM queries and indexing',
        dueAt: tomorrow,
        priority: 'Low',
      },
    });

    assert.equal(res.status, 200);
    assert.ok(res.data.prediction);
    const pred = res.data.prediction;

    assert.equal(pred.riskLevel, 'HIGH');
    assert.ok(pred.delayProbability >= 0.70);
    assert.equal(pred.benchmark.category, 'Software Engineering');
    assert.ok(pred.reasons.length >= 2);

    const deadlineRec = pred.recommendations.find((r) => r.type === 'set_deadline');
    assert.ok(deadlineRec);
    assert.ok(deadlineRec.value);

    const priorityRec = pred.recommendations.find((r) => r.type === 'change_priority');
    assert.ok(priorityRec);
    assert.equal(priorityRec.value, 'High');
  });

  let createdTaskId = '';

  await t.test('POST /api/tasks creates task with priority and category', async () => {
    const res = await client.request('/api/tasks', {
      method: 'POST',
      body: {
        text: 'Design brand guidelines vector icons',
        priority: 'High',
        category: 'Product Design',
      },
    });

    assert.equal(res.status, 201);
    assert.ok(res.data.task);
    assert.equal(res.data.task.priority, 'High');
    assert.equal(res.data.task.category, 'Product Design');
    createdTaskId = res.data.task.id;
  });

  await t.test('GET /api/tasks retrieves task preserving priority and category', async () => {
    const res = await client.request('/api/tasks');
    assert.equal(res.status, 200);
    const found = res.data.tasks.find((t) => t.id === createdTaskId);
    assert.ok(found);
    assert.equal(found.priority, 'High');
    assert.equal(found.category, 'Product Design');
  });

  await t.test('PATCH /api/tasks/:id updates priority and category', async () => {
    const res = await client.request(`/api/tasks/${createdTaskId}`, {
      method: 'PATCH',
      body: {
        priority: 'Urgent',
        category: 'DevOps & Infrastructure',
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.task.priority, 'Urgent');
    assert.equal(res.data.task.category, 'DevOps & Infrastructure');
  });
});
