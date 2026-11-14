import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  Confidence,
  RecommendationStatus,
  RecommendationType,
  RecurringSeries,
  TimeMachineRecommendation,
} from '../shared/types';

export type OutcomeHorizon = '24h' | '7d' | 'deadline' | '30d';

export type OutcomeStatus =
  | 'pending'
  | 'completed_on_time'
  | 'completed_late'
  | 'overdue'
  | 'abandoned'
  | 'deleted_before_due'
  | 'deleted_after_due'
  | 'reopened';

export type RecommendationEventType =
  | 'shown'
  | 'accepted'
  | 'applied'
  | 'dismissed'
  | 'expired'
  | 'superseded';

export interface PredictionRecord {
  id: string;
  taskId: string;
  userId: string;
  createdAt: string;
  modelVersion: string;
  probability: number;
  pLow: number;
  pHigh: number;
  confidence: Confidence;
  mode: 'personal' | 'blended' | 'global';
  sampleSize: number;
  features: Record<string, unknown>;
  holdout: boolean;
  label: 0 | 1 | null;
  labeledAt: string | null;
  outcomeStatus: OutcomeStatus | null;
  supersededAt: string | null;
}

export interface RecommendationRecord extends TimeMachineRecommendation {
  taskId: string;
  userId: string;
  status: RecommendationStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  predictionId: string | null;
  dismissedReason: string | null;
  cooldownUntil: string | null;
}

export interface RecommendationEvent {
  id: string;
  recommendationId: string;
  taskId: string;
  userId: string;
  type: RecommendationEventType;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface OutcomeRecord {
  id: string;
  taskId: string;
  userId: string;
  horizon: OutcomeHorizon;
  status: OutcomeStatus;
  observedAt: string;
  revision: number;
  metadata: Record<string, unknown>;
}

export interface ModelState {
  userId: string;
  a: number;
  b: number;
  labeledCount: number;
  updatedAt: string;
}

export interface ReminderRecord {
  id: string;
  taskId: string;
  userId: string;
  remindAt: string;
  status: 'scheduled' | 'sent' | 'dismissed';
  createdAt: string;
  updatedAt: string;
}

interface TimeMachineFile {
  version: 1;
  predictions: PredictionRecord[];
  recommendations: RecommendationRecord[];
  events: RecommendationEvent[];
  outcomes: OutcomeRecord[];
  modelStates: ModelState[];
  reminders: ReminderRecord[];
  series: RecurringSeries[];
}

function emptyFile(): TimeMachineFile {
  return {
    version: 1,
    predictions: [],
    recommendations: [],
    events: [],
    outcomes: [],
    modelStates: [],
    reminders: [],
    series: [],
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Atomic JSON persistence for Time Machine snapshots, recommendations,
 * recommendation events, outcomes, reminders, recurring series, and the
 * per-user calibration state. This is the bridge store for the current
 * JSON-first runtime; the Postgres repositories will replace it in Phase 1.
 */
export class TimeMachineStore {
  private data: TimeMachineFile = emptyFile();
  private opChain: Promise<unknown> = Promise.resolve();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<TimeMachineFile>;
      this.data = {
        version: 1,
        predictions: Array.isArray(parsed.predictions) ? parsed.predictions : [],
        recommendations: Array.isArray(parsed.recommendations)
          ? parsed.recommendations
          : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
        outcomes: Array.isArray(parsed.outcomes) ? parsed.outcomes : [],
        modelStates: Array.isArray(parsed.modelStates) ? parsed.modelStates : [],
        reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
        series: Array.isArray(parsed.series) ? parsed.series : [],
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.error(
          `Could not read ${this.file}; starting with empty Time Machine data.`,
          error,
        );
        try {
          await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          // The next write recreates the file.
        }
      }
      this.data = emptyFile();
      await this.persist(this.data);
    }
  }

  latestPrediction(taskId: string, userId: string): PredictionRecord | null {
    const matches = this.data.predictions
      .filter((record) => record.taskId === taskId && record.userId === userId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return matches[0] ? clone(matches[0]) : null;
  }

  listPredictions(userId: string): PredictionRecord[] {
    return this.data.predictions
      .filter((record) => record.userId === userId)
      .map(clone);
  }

  async addPrediction(record: PredictionRecord): Promise<PredictionRecord> {
    return this.mutate((data) => {
      const next = {
        ...data,
        predictions: [...data.predictions, record],
      };
      return { next, result: clone(record) };
    });
  }

  async supersedePredictions(
    taskId: string,
    userId: string,
    supersededAt: string,
  ): Promise<number> {
    return this.mutate((data) => {
      let changed = 0;
      const predictions = data.predictions.map((record) => {
        if (
          record.taskId === taskId &&
          record.userId === userId &&
          record.supersededAt === null
        ) {
          changed += 1;
          return { ...record, supersededAt };
        }
        return record;
      });
      return { next: { ...data, predictions }, result: changed };
    });
  }

  async labelPredictions(
    taskId: string,
    userId: string,
    label: 0 | 1,
    outcomeStatus: OutcomeStatus,
    labeledAt: string,
    onlyBefore?: string,
  ): Promise<number> {
    return this.mutate((data) => {
      const cutoff = onlyBefore ? Date.parse(onlyBefore) : null;
      let changed = 0;
      const predictions = data.predictions.map((record) => {
        if (
          record.taskId !== taskId ||
          record.userId !== userId ||
          record.label !== null
        ) {
          return record;
        }
        if (cutoff !== null && Date.parse(record.createdAt) > cutoff) {
          return record;
        }
        changed += 1;
        return { ...record, label, outcomeStatus, labeledAt };
      });
      return { next: { ...data, predictions }, result: changed };
    });
  }

  async upsertRecommendations(
    records: RecommendationRecord[],
  ): Promise<RecommendationRecord[]> {
    return this.mutate((data) => {
      const byId = new Map(data.recommendations.map((record) => [record.id, record]));
      for (const record of records) {
        const existing = byId.get(record.id);
        if (!existing || existing.status === 'active') {
          byId.set(record.id, record);
        }
      }
      const recommendations = [...byId.values()];
      return {
        next: { ...data, recommendations },
        result: records.map((record) => clone(byId.get(record.id) ?? record)),
      };
    });
  }

  getRecommendation(id: string): RecommendationRecord | null {
    const record = this.data.recommendations.find((entry) => entry.id === id);
    return record ? clone(record) : null;
  }

  listRecommendations(taskId: string, userId: string): RecommendationRecord[] {
    return this.data.recommendations
      .filter((record) => record.taskId === taskId && record.userId === userId)
      .map(clone);
  }

  listDismissedTypes(
    taskId: string,
    userId: string,
    now: string,
  ): RecommendationType[] {
    const current = Date.parse(now);
    return this.data.recommendations
      .filter(
        (record) =>
          record.taskId === taskId &&
          record.userId === userId &&
          record.status === 'dismissed' &&
          record.cooldownUntil !== null &&
          Date.parse(record.cooldownUntil) > current,
      )
      .map((record) => record.type);
  }

  async setRecommendationStatus(
    id: string,
    userId: string,
    status: RecommendationStatus,
    patch: Partial<RecommendationRecord> = {},
  ): Promise<RecommendationRecord | null> {
    return this.mutate((data) => {
      let result: RecommendationRecord | null = null;
      const recommendations = data.recommendations.map((record) => {
        if (record.id !== id || record.userId !== userId) return record;
        result = {
          ...record,
          ...patch,
          status,
          updatedAt: patch.updatedAt ?? new Date().toISOString(),
        };
        return result;
      });
      return { next: { ...data, recommendations }, result: result ? clone(result) : null };
    });
  }

  async logEvent(
    event: Omit<RecommendationEvent, 'id' | 'createdAt'>,
  ): Promise<RecommendationEvent> {
    const record: RecommendationEvent = {
      ...event,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    return this.mutate((data) => ({
      next: { ...data, events: [...data.events, record] },
      result: clone(record),
    }));
  }

  hasImpression(recommendationId: string, dayKey: string): boolean {
    return this.data.events.some(
      (event) =>
        event.recommendationId === recommendationId &&
        event.type === 'shown' &&
        event.metadata.dayKey === dayKey,
    );
  }

  listEvents(userId: string): RecommendationEvent[] {
    return this.data.events
      .filter((event) => event.userId === userId)
      .map(clone);
  }

  async recordOutcome(
    outcome: Omit<OutcomeRecord, 'id' | 'revision'>,
  ): Promise<OutcomeRecord> {
    return this.mutate((data) => {
      const existing = data.outcomes.find(
        (record) =>
          record.taskId === outcome.taskId &&
          record.horizon === outcome.horizon,
      );
      if (existing) {
        if (existing.status === outcome.status) {
          return { next: data, result: clone(existing) };
        }
        const updated: OutcomeRecord = {
          ...existing,
          status: outcome.status,
          metadata: { ...existing.metadata, ...outcome.metadata },
          revision: existing.revision + 1,
        };
        const outcomes = data.outcomes.map((record) =>
          record.id === existing.id ? updated : record,
        );
        return { next: { ...data, outcomes }, result: clone(updated) };
      }

      const record: OutcomeRecord = {
        ...outcome,
        id: randomUUID(),
        revision: 1,
      };
      return {
        next: { ...data, outcomes: [...data.outcomes, record] },
        result: clone(record),
      };
    });
  }

  listOutcomes(userId: string, taskId?: string): OutcomeRecord[] {
    return this.data.outcomes
      .filter(
        (record) =>
          record.userId === userId &&
          (taskId === undefined || record.taskId === taskId),
      )
      .map(clone);
  }

  getModelState(userId: string): ModelState | null {
    const state = this.data.modelStates.find((entry) => entry.userId === userId);
    return state ? clone(state) : null;
  }

  async saveModelState(state: ModelState): Promise<ModelState> {
    return this.mutate((data) => {
      const exists = data.modelStates.some((entry) => entry.userId === state.userId);
      const modelStates = exists
        ? data.modelStates.map((entry) =>
            entry.userId === state.userId ? state : entry,
          )
        : [...data.modelStates, state];
      return { next: { ...data, modelStates }, result: clone(state) };
    });
  }

  async createReminder(
    reminder: Omit<ReminderRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ReminderRecord> {
    const now = new Date().toISOString();
    const record: ReminderRecord = {
      ...reminder,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    return this.mutate((data) => ({
      next: { ...data, reminders: [...data.reminders, record] },
      result: clone(record),
    }));
  }

  listReminders(
    userId: string,
    status?: ReminderRecord['status'],
  ): ReminderRecord[] {
    return this.data.reminders
      .filter(
        (record) =>
          record.userId === userId &&
          (status === undefined || record.status === status),
      )
      .map(clone);
  }

  async dismissReminder(id: string, userId: string): Promise<boolean> {
    return this.mutate((data) => {
      let changed = false;
      const reminders = data.reminders.map((record) => {
        if (record.id !== id || record.userId !== userId) return record;
        changed = true;
        return {
          ...record,
          status: 'dismissed' as const,
          updatedAt: new Date().toISOString(),
        };
      });
      return { next: { ...data, reminders }, result: changed };
    });
  }

  async upsertSeries(series: RecurringSeries): Promise<RecurringSeries> {
    return this.mutate((data) => {
      const exists = data.series.some((entry) => entry.id === series.id);
      const nextSeries = exists
        ? data.series.map((entry) => (entry.id === series.id ? series : entry))
        : [...data.series, series];
      return { next: { ...data, series: nextSeries }, result: clone(series) };
    });
  }

  findSeries(
    userId: string,
    rrule: string,
    title: string,
  ): RecurringSeries | null {
    const normalized = title.trim().toLowerCase();
    const record = this.data.series.find(
      (entry) =>
        entry.userId === userId &&
        entry.rrule === rrule &&
        entry.title.trim().toLowerCase() === normalized,
    );
    return record ? clone(record) : null;
  }

  listSeries(userId: string): RecurringSeries[] {
    return this.data.series
      .filter((record) => record.userId === userId)
      .map(clone);
  }

  /** Everything this user owns, for the account data export endpoint. */
  exportForUser(userId: string): {
    predictions: PredictionRecord[];
    recommendations: RecommendationRecord[];
    events: RecommendationEvent[];
    outcomes: OutcomeRecord[];
    modelState: ModelState | null;
    reminders: ReminderRecord[];
    series: RecurringSeries[];
  } {
    return {
      predictions: this.listPredictions(userId),
      recommendations: this.data.recommendations
        .filter((record) => record.userId === userId)
        .map(clone),
      events: this.listEvents(userId),
      outcomes: this.listOutcomes(userId),
      modelState: this.getModelState(userId),
      reminders: this.listReminders(userId),
      series: this.listSeries(userId),
    };
  }

  /** Remove all Time Machine data for an account being deleted. */
  async deleteForUser(userId: string): Promise<void> {
    await this.mutate((data) => ({
      next: {
        ...data,
        predictions: data.predictions.filter(
          (record) => record.userId !== userId,
        ),
        recommendations: data.recommendations.filter(
          (record) => record.userId !== userId,
        ),
        events: data.events.filter((record) => record.userId !== userId),
        outcomes: data.outcomes.filter((record) => record.userId !== userId),
        modelStates: data.modelStates.filter(
          (record) => record.userId !== userId,
        ),
        reminders: data.reminders.filter(
          (record) => record.userId !== userId,
        ),
        series: data.series.filter((record) => record.userId !== userId),
      },
      result: undefined,
    }));
  }

  private mutate<T>(
    fn: (data: TimeMachineFile) => { next: TimeMachineFile; result: T },
  ): Promise<T> {
    const run = this.opChain.then(async () => {
      const { next, result } = fn(clone(this.data));
      await this.persist(next);
      this.data = next;
      return result;
    });
    this.opChain = run.catch(() => {});
    return run;
  }

  private async persist(data: TimeMachineFile): Promise<void> {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true });
    const temp = `${this.file}.tmp-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await fs.writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(temp, this.file);
  }
}
