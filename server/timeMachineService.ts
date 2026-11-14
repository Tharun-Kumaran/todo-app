import { createHash, randomUUID } from 'node:crypto';
import type {
  RecurringSeries,
  Task,
  TimeMachineInsights,
  TimeMachineRecommendation,
  TimeMachineResponse,
} from '../shared/types';
import {
  TIME_MACHINE_MODEL_VERSION,
  brierScore,
  buildTimeMachine,
  expectedCalibrationError,
  fitCalibration,
  isHoldoutTask,
  type Calibration,
  type TimeMachineTaskInput,
} from './timeMachine';
import type { TaskStore } from './store';
import {
  TimeMachineStore,
  type OutcomeHorizon,
  type OutcomeStatus,
  type PredictionRecord,
  type RecommendationRecord,
} from './timeMachineStore';

const DAY_MS = 86_400_000;
const SNAPSHOT_TTL_MS = 15 * 60 * 1000;
const DISMISS_COOLDOWN_MS = 7 * DAY_MS;
const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export class TimeMachineError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'TimeMachineError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface TimeMachineDeps {
  tasks: TaskStore;
  timeMachine: TimeMachineStore;
}

function toInput(task: Task): TimeMachineTaskInput {
  return {
    id: task.id,
    text: task.text,
    dueAt: task.dueAt,
    priority: task.priority,
    category: task.category,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    done: task.done,
    scheduledStartAt: task.scheduledStartAt,
    reminderAt: task.reminderAt,
    milestones: task.milestones,
  };
}

function calibrationFromState(
  state: ReturnType<TimeMachineStore['getModelState']>,
): Calibration | undefined {
  if (!state) return undefined;
  return { a: state.a, b: state.b, count: state.labeledCount };
}

function leadDaysBucket(dueAt: string | null, now: number): string {
  if (!dueAt) return 'none';
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return 'none';
  const days = (due - now) / DAY_MS;
  if (days < 1) return '<1d';
  if (days < 3) return '1-3d';
  if (days < 7) return '3-7d';
  if (days < 14) return '7-14d';
  return '14d+';
}

function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function completionStatus(task: Task): OutcomeStatus {
  const completed = Date.parse(task.completedAt ?? task.updatedAt);
  const due = task.dueAt
    ? Date.parse(task.dueAt)
    : Date.parse(task.createdAt) + 7 * DAY_MS;
  return completed <= due ? 'completed_on_time' : 'completed_late';
}

function completionHorizon(task: Task): OutcomeHorizon {
  return task.dueAt ? 'deadline' : '7d';
}

async function recordOutcomeAndLabel(params: {
  task: Task;
  userId: string;
  status: OutcomeStatus;
  horizon: OutcomeHorizon;
  timeMachine: TimeMachineStore;
  nowIso: string;
  onlyBefore?: string;
}): Promise<void> {
  const { task, userId, status, horizon, timeMachine, nowIso } = params;
  await timeMachine.recordOutcome({
    taskId: task.id,
    userId,
    horizon,
    status,
    observedAt: nowIso,
    metadata: {
      source: 'time-machine-service',
      completedAt: task.completedAt,
      dueAt: task.dueAt,
    },
  });

  const label =
    status === 'completed_on_time'
      ? 1
      : status === 'completed_late' ||
          status === 'overdue' ||
          status === 'abandoned' ||
          status === 'deleted_before_due' ||
          status === 'deleted_after_due' ||
          status === 'reopened'
        ? 0
        : null;
  if (label !== null) {
    await timeMachine.labelPredictions(
      task.id,
      userId,
      label,
      status,
      nowIso,
      params.onlyBefore,
    );
  }
}

async function expireActiveRecommendations(params: {
  taskId: string;
  userId: string;
  timeMachine: TimeMachineStore;
  reason: string;
}): Promise<void> {
  const active = params.timeMachine
    .listRecommendations(params.taskId, params.userId)
    .filter((record) => record.status === 'active');
  for (const record of active) {
    await params.timeMachine.setRecommendationStatus(
      record.id,
      params.userId,
      'expired',
    );
    await params.timeMachine.logEvent({
      recommendationId: record.id,
      taskId: params.taskId,
      userId: params.userId,
      type: 'expired',
      metadata: { reason: params.reason },
    });
  }
}

async function ensureSnapshot(params: {
  task: Task;
  userId: string;
  history: Task[];
  response: TimeMachineResponse;
  timeMachine: TimeMachineStore;
  now: Date;
  holdout: boolean;
}): Promise<PredictionRecord | null> {
  const { task, userId, history, response, timeMachine, now, holdout } = params;
  if (task.teamId || task.done) {
    return timeMachine.latestPrediction(task.id, userId);
  }

  const latest = timeMachine.latestPrediction(task.id, userId);
  const fresh =
    latest !== null &&
    now.getTime() - Date.parse(latest.createdAt) < SNAPSHOT_TTL_MS &&
    Date.parse(task.updatedAt) <= Date.parse(latest.createdAt) + 1000;
  if (fresh && latest) return latest;

  const nowIso = now.toISOString();
  await timeMachine.supersedePredictions(task.id, userId, nowIso);
  return timeMachine.addPrediction({
    id: randomUUID(),
    taskId: task.id,
    userId,
    createdAt: nowIso,
    modelVersion: TIME_MACHINE_MODEL_VERSION,
    probability: response.baseline.completionProbability,
    pLow: response.baseline.interval[0],
    pHigh: response.baseline.interval[1],
    confidence: response.baseline.confidence,
    mode: response.baseline.mode,
    sampleSize: response.baseline.sampleSize,
    features: {
      category: task.category ?? null,
      priority: task.priority ?? 'Medium',
      leadDaysBucket: leadDaysBucket(task.dueAt, now.getTime()),
      weekdayBucket: now.getDay(),
      textHash: textHash(task.text),
      similarTaskIds: response.baseline.evidence.map((entry) => entry.taskId),
      milestoneCount: task.milestones.length,
      historySize: history.length,
    },
    holdout,
    label: null,
    labeledAt: null,
    outcomeStatus: null,
    supersededAt: null,
  });
}

export async function getTimeMachineForTask(params: {
  deps: TimeMachineDeps;
  userId: string;
  task: Task;
  history: Task[];
  now?: Date;
  persist?: boolean;
}): Promise<TimeMachineResponse> {
  const { deps, userId, task, history } = params;
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const holdout = isHoldoutTask(task.id);
  const dismissedTypes = deps.timeMachine.listDismissedTypes(
    task.id,
    userId,
    nowIso,
  );
  const modelState = deps.timeMachine.getModelState(userId);
  const teamTask = Boolean(task.teamId);

  const response = buildTimeMachine(toInput(task), history, {
    now,
    calibration: calibrationFromState(modelState),
    holdout,
    dismissedTypes,
    teamTask,
    includeRecommendations: !teamTask && !holdout && !task.done,
  });

  if (params.persist === false || teamTask) return response;

  const prediction = await ensureSnapshot({
    task,
    userId,
    history,
    response,
    timeMachine: deps.timeMachine,
    now,
    holdout,
  });

  const existingActive = deps.timeMachine
    .listRecommendations(task.id, userId)
    .filter((record) => record.status === 'active');

  if (response.recommendations.length > 0) {
    const records: RecommendationRecord[] = response.recommendations.map(
      (recommendation) => ({
        ...recommendation,
        taskId: task.id,
        userId,
        status: 'active',
        createdAt: nowIso,
        updatedAt: nowIso,
        expiresAt: new Date(now.getTime() + DISMISS_COOLDOWN_MS).toISOString(),
        predictionId: prediction?.id ?? null,
        dismissedReason: null,
        cooldownUntil: null,
      }),
    );
    const persisted = await deps.timeMachine.upsertRecommendations(records);
    response.recommendations = response.recommendations.filter(
      (recommendation) =>
        persisted.find((record) => record.id === recommendation.id)?.status ===
        'active',
    );
  } else {
    response.recommendations = [];
  }

  const keep = new Set(response.recommendations.map((record) => record.id));
  for (const record of existingActive) {
    if (keep.has(record.id)) continue;
    await deps.timeMachine.setRecommendationStatus(
      record.id,
      userId,
      'superseded',
    );
    await deps.timeMachine.logEvent({
      recommendationId: record.id,
      taskId: task.id,
      userId,
      type: 'superseded',
      metadata: { reason: 'prediction-refresh' },
    });
  }

  return response;
}

export function previewTimeMachine(params: {
  deps: TimeMachineDeps;
  userId: string;
  draft: TimeMachineTaskInput;
  history: Task[];
  now?: Date;
  teamTask?: boolean;
}): TimeMachineResponse {
  const now = params.now ?? new Date();
  const state = params.deps.timeMachine.getModelState(params.userId);
  return buildTimeMachine(params.draft, params.history, {
    now,
    calibration: calibrationFromState(state),
    teamTask: params.teamTask,
    includeRecommendations: !params.teamTask,
  });
}

export async function recordTaskCreated(params: {
  deps: TimeMachineDeps;
  userId: string;
  task: Task;
  history: Task[];
  now?: Date;
}): Promise<void> {
  if (params.task.teamId || params.task.done) return;
  await getTimeMachineForTask({
    deps: params.deps,
    userId: params.userId,
    task: params.task,
    history: params.history,
    now: params.now,
    persist: true,
  });
}

export async function handleTaskUpdate(params: {
  deps: TimeMachineDeps;
  userId: string;
  before: Task;
  after: Task;
  history: Task[];
  now?: Date;
}): Promise<void> {
  const { deps, userId, before, after } = params;
  if (after.teamId) return;
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();

  if (after.done && !before.done) {
    const status = completionStatus(after);
    await recordOutcomeAndLabel({
      task: after,
      userId,
      status,
      horizon: completionHorizon(after),
      timeMachine: deps.timeMachine,
      nowIso,
      onlyBefore: after.completedAt ?? nowIso,
    });
    await expireActiveRecommendations({
      taskId: after.id,
      userId,
      timeMachine: deps.timeMachine,
      reason: 'task-completed',
    });
    await maybeCalibrate({ deps, userId, now });
    return;
  }

  if (!after.done && before.done) {
    const completedAt = before.completedAt ?? before.updatedAt;
    const reopenedWithinSevenDays =
      now.getTime() - Date.parse(completedAt) <= 7 * DAY_MS;
    await recordOutcomeAndLabel({
      task: after,
      userId,
      status: 'reopened',
      horizon: completionHorizon(after),
      timeMachine: deps.timeMachine,
      nowIso,
      onlyBefore: reopenedWithinSevenDays ? completedAt : undefined,
    });
    await getTimeMachineForTask({
      deps,
      userId,
      task: after,
      history: params.history,
      now,
      persist: true,
    });
    return;
  }

  if (after.done) return;

  const changed =
    before.text !== after.text ||
    before.dueAt !== after.dueAt ||
    before.priority !== after.priority ||
    before.category !== after.category ||
    before.scheduledStartAt !== after.scheduledStartAt ||
    before.reminderAt !== after.reminderAt;

  if (!changed) return;
  await getTimeMachineForTask({
    deps,
    userId,
    task: after,
    history: params.history,
    now,
    persist: true,
  });
}

export async function handleTaskDeleted(params: {
  deps: TimeMachineDeps;
  userId: string;
  task: Task;
  now?: Date;
}): Promise<void> {
  const { deps, userId, task } = params;
  if (task.teamId) return;
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();

  if (!task.done) {
    const deleted = now.getTime();
    const due = task.dueAt
      ? Date.parse(task.dueAt)
      : Date.parse(task.createdAt) + 7 * DAY_MS;
    const status: OutcomeStatus =
      deleted <= due ? 'deleted_before_due' : 'deleted_after_due';
    await recordOutcomeAndLabel({
      task,
      userId,
      status,
      horizon: completionHorizon(task),
      timeMachine: deps.timeMachine,
      nowIso,
    });
  }

  await expireActiveRecommendations({
    taskId: task.id,
    userId,
    timeMachine: deps.timeMachine,
    reason: 'task-deleted',
  });
  await maybeCalibrate({ deps, userId, now });
}

export async function resolveUserOutcomes(params: {
  deps: TimeMachineDeps;
  userId: string;
  tasks: Task[];
  now?: Date;
}): Promise<void> {
  const { deps, userId, tasks } = params;
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();

  for (const task of tasks) {
    if (task.teamId) continue;
    if (task.done) {
      const status = completionStatus(task);
      await recordOutcomeAndLabel({
        task,
        userId,
        status,
        horizon: completionHorizon(task),
        timeMachine: deps.timeMachine,
        nowIso,
        onlyBefore: task.completedAt ?? task.updatedAt,
      });
      continue;
    }

    const due = task.dueAt ? Date.parse(task.dueAt) : null;
    if (due !== null && due < now.getTime()) {
      await recordOutcomeAndLabel({
        task,
        userId,
        status: 'overdue',
        horizon: 'deadline',
        timeMachine: deps.timeMachine,
        nowIso,
      });
      continue;
    }

    if (
      due === null &&
      now.getTime() - Date.parse(task.createdAt) > 30 * DAY_MS
    ) {
      await recordOutcomeAndLabel({
        task,
        userId,
        status: 'abandoned',
        horizon: '30d',
        timeMachine: deps.timeMachine,
        nowIso,
      });
    }
  }

  await maybeCalibrate({ deps, userId, now });
}

export async function maybeCalibrate(params: {
  deps: TimeMachineDeps;
  userId: string;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const predictions = params.deps.timeMachine
    .listPredictions(params.userId)
    .filter((record) => record.label !== null);
  if (predictions.length < 20) return;

  const state = params.deps.timeMachine.getModelState(params.userId);
  if (state && state.labeledCount >= predictions.length - 9) return;

  const calibration = fitCalibration(
    predictions.map((record) => ({
      probability: record.probability,
      label: record.label as 0 | 1,
      ageDays: Math.max(0, (now.getTime() - Date.parse(record.createdAt)) / DAY_MS),
    })),
  );
  if (!calibration) return;

  await params.deps.timeMachine.saveModelState({
    userId: params.userId,
    a: calibration.a,
    b: calibration.b,
    labeledCount: predictions.length,
    updatedAt: now.toISOString(),
  });
}

export async function recordImpressions(params: {
  deps: TimeMachineDeps;
  userId: string;
  ids: string[];
  now?: Date;
}): Promise<number> {
  const now = params.now ?? new Date();
  const dayKey = now.toISOString().slice(0, 10);
  let recorded = 0;
  for (const [index, id] of params.ids.entries()) {
    const record = params.deps.timeMachine.getRecommendation(id);
    if (!record || record.userId !== params.userId) continue;
    if (params.deps.timeMachine.hasImpression(record.id, dayKey)) continue;
    await params.deps.timeMachine.logEvent({
      recommendationId: record.id,
      taskId: record.taskId,
      userId: params.userId,
      type: 'shown',
      metadata: { dayKey, surface: 'task-detail', position: index },
    });
    recorded += 1;
  }
  return recorded;
}

export async function dismissRecommendation(params: {
  deps: TimeMachineDeps;
  userId: string;
  recommendationId: string;
  reason?: string;
  now?: Date;
}): Promise<RecommendationRecord | null> {
  const record = params.deps.timeMachine.getRecommendation(
    params.recommendationId,
  );
  if (!record || record.userId !== params.userId) return null;
  if (record.status !== 'active') return record;

  const now = params.now ?? new Date();
  const cooldownUntil = new Date(now.getTime() + DISMISS_COOLDOWN_MS).toISOString();
  const updated = await params.deps.timeMachine.setRecommendationStatus(
    record.id,
    params.userId,
    'dismissed',
    {
      dismissedReason: params.reason ?? 'not_useful',
      cooldownUntil,
      updatedAt: now.toISOString(),
    },
  );
  await params.deps.timeMachine.logEvent({
    recommendationId: record.id,
    taskId: record.taskId,
    userId: params.userId,
    type: 'dismissed',
    metadata: { reason: params.reason ?? 'not_useful', cooldownUntil },
  });
  return updated;
}

export async function applyRecommendation(params: {
  deps: TimeMachineDeps;
  userId: string;
  task: Task;
  userTeamIds: string[];
  recommendationId: string;
  expectedVersion?: number;
  now?: Date;
}): Promise<{
  task: Task;
  timeMachine: TimeMachineResponse;
  recommendation: TimeMachineRecommendation;
  series?: RecurringSeries;
}> {
  const { deps, userId, task, userTeamIds } = params;
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const record = deps.timeMachine.getRecommendation(params.recommendationId);

  if (!record || record.userId !== userId || record.taskId !== task.id) {
    throw new TimeMachineError(
      404,
      'RECOMMENDATION_NOT_FOUND',
      'Recommendation not found.',
    );
  }
  if (record.status !== 'active') {
    throw new TimeMachineError(
      409,
      'RECOMMENDATION_INACTIVE',
      'This recommendation is no longer active.',
      { status: record.status },
    );
  }
  if (task.teamId) {
    throw new TimeMachineError(
      422,
      'TEAM_TASK_BASELINE_ONLY',
      'Recommendations are not available for team tasks yet.',
    );
  }
  if (
    params.expectedVersion !== undefined &&
    params.expectedVersion !== task.version
  ) {
    throw new TimeMachineError(
      409,
      'TASK_VERSION_CONFLICT',
      'The task changed since this recommendation was generated.',
      { currentTask: task },
    );
  }

  let updatedTask: Task | null = task;
  let series: RecurringSeries | undefined;

  if (record.type === 'split_subtasks') {
    const checkpoints = record.payload.milestones ?? [];
    if (checkpoints.length === 0) {
      throw new TimeMachineError(
        422,
        'EMPTY_RECOMMENDATION',
        'This recommendation has no checkpoints to add.',
      );
    }
    updatedTask = await deps.tasks.addMilestones(
      userId,
      task.id,
      userTeamIds,
      checkpoints.map((text) => ({ text, progress: task.progress })),
    );
  } else if (record.type === 'recurrence_series') {
    if (!record.payload.rrule) {
      throw new TimeMachineError(
        422,
        'EMPTY_RECOMMENDATION',
        'This recommendation has no recurrence rule.',
      );
    }
    series = {
      id: randomUUID(),
      userId,
      title: record.payload.title ?? task.text,
      rrule: record.payload.rrule,
      timezone: 'UTC',
      autoCreate: false,
      status: 'active',
      nextAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await deps.timeMachine.upsertSeries(series);
  } else {
    const patch: {
      dueAt?: string;
      scheduledStartAt?: string;
      reminderAt?: string;
    } = {};
    if (record.type === 'deadline_change' && record.payload.dueAt) {
      patch.dueAt = record.payload.dueAt;
    } else if (
      record.type === 'schedule_window' &&
      record.payload.scheduledStartAt
    ) {
      patch.scheduledStartAt = record.payload.scheduledStartAt;
    } else if (record.type === 'reminder' && record.payload.reminderAt) {
      patch.reminderAt = record.payload.reminderAt;
    } else {
      throw new TimeMachineError(
        422,
        'EMPTY_RECOMMENDATION',
        'This recommendation has no applicable payload.',
      );
    }
    updatedTask = await deps.tasks.update(userId, task.id, userTeamIds, patch);
  }

  if (!updatedTask) {
    throw new TimeMachineError(404, 'TASK_NOT_FOUND', 'Task not found.');
  }

  if (record.type === 'reminder' && record.payload.reminderAt) {
    await deps.timeMachine.createReminder({
      taskId: task.id,
      userId,
      remindAt: record.payload.reminderAt,
      status: 'scheduled',
    });
  }

  await deps.timeMachine.setRecommendationStatus(
    record.id,
    userId,
    'accepted',
    { updatedAt: nowIso },
  );
  await deps.timeMachine.logEvent({
    recommendationId: record.id,
    taskId: task.id,
    userId,
    type: 'accepted',
    metadata: { expectedVersion: params.expectedVersion ?? null },
  });
  await deps.timeMachine.logEvent({
    recommendationId: record.id,
    taskId: task.id,
    userId,
    type: 'applied',
    metadata: {
      before: {
        dueAt: task.dueAt,
        scheduledStartAt: task.scheduledStartAt,
        reminderAt: task.reminderAt,
      },
      after: {
        dueAt: updatedTask.dueAt,
        scheduledStartAt: updatedTask.scheduledStartAt,
        reminderAt: updatedTask.reminderAt,
      },
      taskVersion: updatedTask.version,
    },
  });

  const history = deps.tasks.listFor(userId, null);
  const timeMachine = await getTimeMachineForTask({
    deps,
    userId,
    task: updatedTask,
    history,
    now,
    persist: true,
  });

  return {
    task: updatedTask,
    timeMachine,
    recommendation: record,
    series,
  };
}

export async function getInsights(params: {
  deps: TimeMachineDeps;
  userId: string;
  tasks: Task[];
  now?: Date;
}): Promise<TimeMachineInsights> {
  const { deps, userId, tasks } = params;
  const now = params.now ?? new Date();
  await resolveUserOutcomes({ deps, userId, tasks, now });

  const predictions = deps.timeMachine
    .listPredictions(userId)
    .filter((record) => record.label !== null);
  const samples = predictions.map((record) => ({
    probability: record.probability,
    label: record.label as 0 | 1,
  }));
  const events = deps.timeMachine.listEvents(userId);
  const shown = events.filter((event) => event.type === 'shown').length;
  const accepted = events.filter((event) => event.type === 'accepted').length;
  const dismissed = events.filter((event) => event.type === 'dismissed').length;

  const completed = tasks.filter(
    (task) => !task.teamId && task.done && task.completedAt,
  );
  const byWeekday = new Map<number, { n: number; onTime: number }>();
  const byCategory = new Map<string, number[]>();
  const repeated = new Map<string, { text: string; count: number }>();

  for (const task of completed) {
    const completedAt = Date.parse(task.completedAt as string);
    const due = task.dueAt
      ? Date.parse(task.dueAt)
      : Date.parse(task.createdAt) + 7 * DAY_MS;
    const onTime = completedAt <= due;
    const weekday = new Date(completedAt).getDay();
    const weekdayBucket = byWeekday.get(weekday) ?? { n: 0, onTime: 0 };
    weekdayBucket.n += 1;
    weekdayBucket.onTime += onTime ? 1 : 0;
    byWeekday.set(weekday, weekdayBucket);

    const category = task.category ?? 'Uncategorized';
    const durations = byCategory.get(category) ?? [];
    durations.push((completedAt - Date.parse(task.createdAt)) / DAY_MS);
    byCategory.set(category, durations);

    const key = task.text.trim().toLowerCase();
    const repeatedEntry = repeated.get(key) ?? { text: task.text.trim(), count: 0 };
    repeatedEntry.count += 1;
    repeated.set(key, repeatedEntry);
  }

  const patterns: TimeMachineInsights['patterns'] = [];
  const bestWeekday = [...byWeekday.entries()].sort(
    (a, b) => b[1].onTime / b[1].n - a[1].onTime / a[1].n,
  )[0];
  if (bestWeekday) {
    patterns.push({
      label: 'Best completion day',
      detail: `${WEEKDAYS[bestWeekday[0]]} (${Math.round((bestWeekday[1].onTime / bestWeekday[1].n) * 100)}% on time)`,
      sampleSize: bestWeekday[1].n,
    });
  }

  const slowestCategory = [...byCategory.entries()]
    .map(([category, durations]) => ({
      category,
      durations,
      median:
        [...durations].sort((a, b) => a - b)[
          Math.floor(durations.length / 2)
        ] ?? 0,
    }))
    .sort((a, b) => b.median - a.median)[0];
  if (slowestCategory) {
    patterns.push({
      label: 'Typical duration',
      detail: `${slowestCategory.category}: ${Math.round(slowestCategory.median * 10) / 10} days median`,
      sampleSize: slowestCategory.durations.length,
    });
  }

  const recurring = [...repeated.values()]
    .filter((entry) => entry.count >= 3)
    .sort((a, b) => b.count - a.count)[0];
  if (recurring) {
    patterns.push({
      label: 'Recurring candidate',
      detail: `"${recurring.text}" repeated ${recurring.count} times`,
      sampleSize: recurring.count,
    });
  }

  return {
    resolved: samples.length,
    brier: brierScore(samples),
    baselineBrier: brierScore(
      samples.map((sample) => ({ probability: 0.55, label: sample.label })),
    ),
    calibrationError: expectedCalibrationError(samples),
    coldStart: samples.length < 20,
    recommendations: {
      shown,
      accepted,
      dismissed,
      acceptanceRate: shown > 0 ? Math.round((accepted / shown) * 1000) / 1000 : null,
    },
    patterns,
  };
}
