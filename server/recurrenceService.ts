import { randomUUID } from 'node:crypto';
import type { RecurringSeries, Task } from '../shared/types';
import {
  atNineUtc,
  nextOccurrence,
  normalizeSeriesTitle,
  parseRrule,
} from '../shared/recurrence.ts';
import { detectRecurringPatterns } from './recurrence.ts';
import type { TaskStore } from './store';
import type { SeriesPatch, TimeMachineStore } from './timeMachineStore';

const DAY_MS = 86_400_000;
const HORIZON_DAYS = 7;
const MAX_OCCURRENCES_PER_RUN = 10;
const MAX_CATCH_UP_STEPS = 400;
const MAINTENANCE_INTERVAL_MS = 30_000;

/**
 * Structural dependency so this module does not import the Time Machine
 * service (which imports SeriesPatch-adjacent types back).
 */
export interface SeriesDeps {
  tasks: TaskStore;
  timeMachine: TimeMachineStore;
}

/** Per-user throttle for the lazy maintenance pass. */
const lastRun = new Map<string, number>();

function asDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * First occurrence strictly in the future, anchored at 09:00 UTC.
 *
 * Starting from yesterday's 09:00 makes today's slot eligible before it is
 * materialized, while the loop skips slots that have already passed.
 */
export function firstOccurrenceAfter(rrule: string, now: Date): Date | null {
  if (!parseRrule(rrule)) return null;
  let cursor = nextOccurrence(
    rrule,
    atNineUtc(new Date(now.getTime() - DAY_MS)),
  );
  if (!cursor) return null;
  cursor = atNineUtc(cursor);
  for (let step = 0; step < MAX_CATCH_UP_STEPS; step += 1) {
    if (cursor.getTime() > now.getTime()) return cursor;
    const following = nextOccurrence(rrule, cursor);
    if (!following) return null;
    cursor = atNineUtc(following);
  }
  return cursor;
}

function hasOpenOccurrence(tasks: Task[], seriesId: string): boolean {
  return tasks.some((task) => !task.done && task.seriesId === seriesId);
}

async function materializeSeries(params: {
  deps: SeriesDeps;
  userId: string;
  series: RecurringSeries;
  tasks: Task[];
  now: Date;
}): Promise<void> {
  const { deps, userId, series, tasks, now } = params;
  if (series.status !== 'active' || !series.autoCreate) return;

  const seeded = asDate(series.nextAt) ?? firstOccurrenceAfter(series.rrule, now);
  if (!seeded) return;

  let cursor = atNineUtc(seeded);
  // Do not backfill a long outage with weeks of missed tasks. Advance past
  // anything older than yesterday instead.
  for (let step = 0; step < MAX_CATCH_UP_STEPS; step += 1) {
    if (cursor.getTime() >= now.getTime() - DAY_MS) break;
    const following = nextOccurrence(series.rrule, cursor);
    if (!following) return;
    cursor = atNineUtc(following);
  }

  const horizon = now.getTime() + HORIZON_DAYS * DAY_MS;
  let created = 0;
  let open = hasOpenOccurrence(tasks, series.id);

  while (
    !open &&
    cursor.getTime() <= horizon &&
    created < MAX_OCCURRENCES_PER_RUN
  ) {
    const occurrence = cursor.toISOString();
    const exists = await deps.tasks.hasOccurrence(series.id, occurrence);
    if (!exists) {
      await deps.tasks.addRecurring(
        userId,
        null,
        series.title,
        occurrence,
        series.id,
      );
      created += 1;
      // One outstanding task per series keeps the list from filling up while
      // the user is behind.
      open = true;
    }
    const following = nextOccurrence(series.rrule, cursor);
    if (!following) break;
    cursor = atNineUtc(following);
  }

  const nextAt = cursor.toISOString();
  if (series.nextAt !== nextAt || created > 0) {
    await deps.timeMachine.updateSeries(userId, series.id, {
      nextAt,
      ...(created > 0 ? { lastMaterializedAt: now.toISOString() } : {}),
    });
  }
}

/**
 * Detect new patterns and materialize active auto-create series.
 *
 * Cheap enough to run lazily on list requests; per-user writes are throttled
 * to once every 30 seconds unless `force` is set.
 */
export async function runSeriesMaintenance(params: {
  deps: SeriesDeps;
  userId: string;
  tasks: Task[];
  now?: Date;
  force?: boolean;
}): Promise<RecurringSeries[]> {
  const { deps, userId, tasks } = params;
  const now = params.now ?? new Date();

  if (!params.force) {
    const last = lastRun.get(userId) ?? 0;
    if (now.getTime() - last < MAINTENANCE_INTERVAL_MS) {
      return deps.timeMachine.listSeries(userId);
    }
  }
  lastRun.set(userId, now.getTime());

  await refreshSuggestions(deps, userId, tasks, now);

  const series = deps.timeMachine.listSeries(userId);
  const active = series.some(
    (record) => record.status === 'active' && record.autoCreate,
  );
  // Re-read tasks once so a task created by an earlier pass (or another
  // request) is visible to the open-occurrence guard.
  const currentTasks = active ? await deps.tasks.listFor(userId, null) : tasks;
  for (const record of series) {
    if (record.status !== 'active' || !record.autoCreate) continue;
    try {
      await materializeSeries({ deps, userId, series: record, tasks: currentTasks, now });
    } catch (error) {
      // One bad series must not break the rest of the list request.
      console.error(`Series materialization failed for ${record.id}:`, error);
    }
  }
  return deps.timeMachine.listSeries(userId);
}

/**
 * Create one suggestion per detected pattern, and keep existing suggestions in
 * sync with fresher history. Series the user activated, paused, or ended are
 * never overwritten by detection.
 */
export async function refreshSuggestions(
  deps: SeriesDeps,
  userId: string,
  tasks: Task[],
  now: Date,
): Promise<void> {
  const existing = deps.timeMachine.listSeries(userId);
  const byKey = new Map(
    existing.map((series) => [normalizeSeriesTitle(series.title), series]),
  );

  for (const pattern of detectRecurringPatterns(tasks)) {
    const found = byKey.get(pattern.key);
    if (!found) {
      const createdAt = now.toISOString();
      await deps.timeMachine.upsertSeries({
        id: randomUUID(),
        userId,
        title: pattern.title,
        rrule: pattern.rrule,
        timezone: 'UTC',
        autoCreate: false,
        status: 'suggested',
        nextAt: pattern.nextAt,
        sampleCount: pattern.sampleCount,
        detectionConfidence: pattern.confidence,
        lastMaterializedAt: null,
        createdAt,
        updatedAt: createdAt,
      });
      continue;
    }
    if (found.status !== 'suggested') continue;
    if (
      found.rrule === pattern.rrule &&
      found.sampleCount === pattern.sampleCount &&
      found.detectionConfidence === pattern.confidence
    ) {
      continue;
    }
    await deps.timeMachine.updateSeries(userId, found.id, {
      title: pattern.title,
      rrule: pattern.rrule,
      nextAt: pattern.nextAt,
      sampleCount: pattern.sampleCount,
      detectionConfidence: pattern.confidence,
    });
  }
}

/** Create a series directly from user input. Returns null on a duplicate title. */
export async function createSeries(params: {
  deps: SeriesDeps;
  userId: string;
  title: string;
  rrule: string;
  autoCreate?: boolean;
  timezone?: string;
  now?: Date;
}): Promise<RecurringSeries | null> {
  const { deps, userId, title, rrule } = params;
  const now = params.now ?? new Date();
  const key = normalizeSeriesTitle(title);
  const duplicate = deps.timeMachine
    .listSeries(userId)
    .some((series) => normalizeSeriesTitle(series.title) === key);
  if (duplicate) return null;

  const createdAt = now.toISOString();
  return deps.timeMachine.upsertSeries({
    id: randomUUID(),
    userId,
    title,
    rrule,
    timezone: params.timezone ?? 'UTC',
    autoCreate: params.autoCreate === true,
    status: 'active',
    nextAt: firstOccurrenceAfter(rrule, now)?.toISOString() ?? null,
    sampleCount: 0,
    detectionConfidence: null,
    lastMaterializedAt: null,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Apply a user control change. Recomputes `nextAt` when the rule or status
 * changes so a resumed series starts from the next future occurrence.
 */
export async function updateSeriesForUser(params: {
  deps: SeriesDeps;
  userId: string;
  id: string;
  patch: SeriesPatch;
  now?: Date;
}): Promise<RecurringSeries | null> {
  const { deps, userId, id, patch } = params;
  const now = params.now ?? new Date();
  const existing = deps.timeMachine.getSeries(userId, id);
  if (!existing) return null;

  const next: SeriesPatch = { ...patch };
  if (patch.rrule && patch.rrule !== existing.rrule) {
    next.nextAt = firstOccurrenceAfter(patch.rrule, now)?.toISOString() ?? null;
  }
  if (patch.status && patch.status !== existing.status) {
    if (patch.status === 'active') {
      next.nextAt =
        next.nextAt ?? firstOccurrenceAfter(patch.rrule ?? existing.rrule, now)?.toISOString() ?? null;
    } else if (patch.status === 'ended') {
      next.nextAt = null;
    }
  }

  return deps.timeMachine.updateSeries(userId, id, next);
}

/**
 * Skip the next occurrence. If a generated task is still open, remove it;
 * otherwise advance `nextAt` past the upcoming occurrence.
 */
export async function skipSeriesOccurrence(params: {
  deps: SeriesDeps;
  userId: string;
  id: string;
  tasks: Task[];
  now?: Date;
}): Promise<RecurringSeries | null> {
  const { deps, userId, id, tasks } = params;
  const now = params.now ?? new Date();
  const series = deps.timeMachine.getSeries(userId, id);
  if (!series) return null;

  const pending = tasks
    .filter((task) => !task.done && task.seriesId === id && task.occurrenceAt)
    .sort(
      (a, b) =>
        Date.parse(a.occurrenceAt ?? '0') - Date.parse(b.occurrenceAt ?? '0'),
    )[0];

  if (pending) {
    // Soft delete keeps the occurrence reserved, so the scheduler will not
    // recreate it.
    await deps.tasks.remove(userId, pending.id, []);
  }

  const from = pending?.occurrenceAt ? new Date(pending.occurrenceAt) : now;
  const base = new Date(Math.max(from.getTime(), now.getTime()));
  const nextAt = firstOccurrenceAfter(series.rrule, base);
  return deps.timeMachine.updateSeries(userId, id, {
    nextAt: nextAt ? nextAt.toISOString() : null,
  });
}

/** Advance a series one period without creating the skipped occurrence. */
export async function endSeriesForUser(params: {
  deps: SeriesDeps;
  userId: string;
  id: string;
}): Promise<RecurringSeries | null> {
  return updateSeriesForUser({ ...params, patch: { status: 'ended' } });
}
