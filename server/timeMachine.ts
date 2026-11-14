import { createHash } from 'node:crypto';
import type {
  Confidence,
  PredictionEvidence,
  Priority,
  RecommendationType,
  RiskLevel,
  TaskCategory,
  TimeMachineBaseline,
  TimeMachineRecommendation,
  TimeMachineResponse,
} from '../shared/types';
import { durationBenchmark, inferCategory } from './prediction.ts';

export const TIME_MACHINE_MODEL_VERSION = 'tm-v2.0.0';
const DAY_MS = 86_400_000;
const RECENCY_HALF_LIFE_DAYS = 90;
const PRIOR_STRENGTH = 8;
const MIN_BUCKET_SAMPLE = 5;
const MIN_BLEND_SAMPLE = 2;
const MAX_RECOMMENDATIONS = 3;
const HOLDOUT_RATE = 0.1;

export interface TimeMachineMilestone {
  id: string;
  text: string;
  progress: number;
  createdAt: string;
}

export interface TimeMachineTaskInput {
  id?: string;
  text: string;
  dueAt: string | null;
  priority?: Priority | null;
  category?: TaskCategory | null;
  createdAt?: string;
  completedAt?: string | null;
  done?: boolean;
  scheduledStartAt?: string | null;
  reminderAt?: string | null;
  milestones?: TimeMachineMilestone[];
  shiftCount?: number;
}

export interface TimeMachineHistoryTask {
  id: string;
  text: string;
  dueAt: string | null;
  priority?: Priority | null;
  category?: TaskCategory | null;
  createdAt: string;
  updatedAt?: string;
  completedAt: string | null;
  done: boolean;
  scheduledStartAt?: string | null;
  reminderAt?: string | null;
  milestones?: TimeMachineMilestone[];
}

export interface Calibration {
  a: number;
  b: number;
  count: number;
}

export interface TimeMachineOptions {
  now?: Date;
  calibration?: Calibration;
  holdout?: boolean;
  dismissedTypes?: Iterable<RecommendationType>;
  teamTask?: boolean;
  includeRecommendations?: boolean;
}

type OutcomeLabel = 'on_time' | 'late' | 'overdue' | 'abandoned';

interface HistoryPoint {
  task: TimeMachineHistoryTask;
  outcome: OutcomeLabel;
  label: 0 | 1;
  durationDays: number | null;
  similarity: number;
  recencyWeight: number;
  completedWeekday: number | null;
  completedHour: number | null;
  category: TaskCategory;
  priority: Priority;
}

interface Bucket {
  n: number;
  successes: number;
  durations: Array<{ x: number; w: number }>;
}

interface BetaLevel {
  p: number;
  n: number;
}

interface DurationLevel {
  mu: number;
  sigma: number;
  n: number;
}

interface CorePrediction {
  probability: number;
  rawProbability: number;
  pLow: number;
  pHigh: number;
  confidence: Confidence;
  sampleSize: number;
  mode: 'personal' | 'blended' | 'global';
  riskLevel: RiskLevel;
  expectedCompletion: { p50: string; p80: string };
  reasons: string[];
  evidence: PredictionEvidence[];
  duration: DurationLevel;
  onTime: BetaLevel;
  nEff: number;
  deadline: string | null;
}

interface Candidate {
  type: RecommendationType;
  label: string;
  payload: TimeMachineRecommendation['payload'];
  recommendedProbability: number;
  estimated: boolean;
  reasons: string[];
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'for',
  'and',
  'or',
  'my',
  'me',
  'please',
  'of',
  'in',
  'on',
  'at',
  'with',
  'this',
  'that',
  'it',
  'is',
  'be',
  'do',
  'from',
  'by',
  'as',
  'up',
  'out',
  'about',
  'into',
]);

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const RRULE_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function parseDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function daysBetween(from: number, to: number): number {
  return (to - from) / DAY_MS;
}

function tokenize(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
  return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

function logit(probability: number): number {
  const p = clamp(probability, 0.0001, 0.9999);
  return Math.log(p / (1 - p));
}

function sigmoid(value: number): number {
  if (value > 40) return 1;
  if (value < -40) return 0;
  return 1 / (1 + Math.exp(-value));
}

/** Abramowitz and Stegun 7.1.26 normal CDF approximation. */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function logNormalQuantile(mu: number, sigma: number, z: number): number {
  return Math.exp(mu + z * sigma);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function hashShort(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 10);
}

/** Deterministic 10% task-level holdout, stable across requests. */
export function isHoldoutTask(taskId: string): boolean {
  const digest = createHash('sha256').update(`tm-holdout:${taskId}`).digest();
  return digest[0] / 256 < HOLDOUT_RATE;
}

function categoryFor(task: TimeMachineHistoryTask | TimeMachineTaskInput): TaskCategory {
  return task.category ?? inferCategory(task.text);
}

function priorityFor(task: TimeMachineHistoryTask | TimeMachineTaskInput): Priority {
  return task.priority ?? 'Medium';
}

function outcomeFor(
  task: TimeMachineHistoryTask,
  now: number,
): { outcome: OutcomeLabel; label: 0 | 1; durationDays: number | null } | null {
  const created = parseDate(task.createdAt) ?? now;
  if (task.done) {
    const completed = parseDate(task.completedAt) ?? parseDate(task.updatedAt) ?? created;
    const due = parseDate(task.dueAt) ?? created + 7 * DAY_MS;
    const onTime = completed <= due;
    return {
      outcome: onTime ? 'on_time' : 'late',
      label: onTime ? 1 : 0,
      durationDays: Math.max(0.01, daysBetween(created, completed)),
    };
  }

  const due = parseDate(task.dueAt);
  if (due !== null && due < now) {
    return { outcome: 'overdue', label: 0, durationDays: null };
  }
  if (due === null && daysBetween(created, now) > 30) {
    return { outcome: 'abandoned', label: 0, durationDays: null };
  }
  return null;
}

function buildPoints(
  target: TimeMachineTaskInput,
  history: TimeMachineHistoryTask[],
  now: number,
): HistoryPoint[] {
  const targetTokens = tokenize(target.text);
  const points: HistoryPoint[] = [];

  for (const task of history) {
    if (target.id && task.id === target.id) continue;
    const outcome = outcomeFor(task, now);
    if (!outcome) continue;

    const completed = parseDate(task.completedAt) ?? parseDate(task.updatedAt);
    const ageDays = completed === null ? 0 : Math.max(0, daysBetween(completed, now));
    const similarity = jaccard(targetTokens, tokenize(task.text));

    points.push({
      task,
      outcome: outcome.outcome,
      label: outcome.label,
      durationDays: outcome.durationDays,
      similarity,
      recencyWeight: 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS),
      completedWeekday:
        completed === null ? null : new Date(completed).getDay(),
      completedHour: completed === null ? null : new Date(completed).getHours(),
      category: categoryFor(task),
      priority: priorityFor(task),
    });
  }

  return points;
}

function emptyBucket(): Bucket {
  return { n: 0, successes: 0, durations: [] };
}

function addToBucket(bucket: Bucket, point: HistoryPoint, weight = point.recencyWeight): void {
  bucket.n += weight;
  bucket.successes += weight * point.label;
  if (point.durationDays !== null) {
    bucket.durations.push({
      x: Math.log(Math.max(point.durationDays, 0.25)),
      w: weight,
    });
  }
}

function makeBuckets(target: TimeMachineTaskInput, points: HistoryPoint[]) {
  const all = emptyBucket();
  const categoryPriority = emptyBucket();
  const similar = emptyBucket();
  const targetCategory = categoryFor(target);
  const targetPriority = priorityFor(target);

  for (const point of points) {
    addToBucket(all, point);
    if (point.category === targetCategory && point.priority === targetPriority) {
      addToBucket(categoryPriority, point);
    }
    if (point.similarity >= 0.35) {
      addToBucket(similar, point, point.recencyWeight * Math.max(0.35, point.similarity));
    }
  }

  return { all, categoryPriority, similar };
}

function betaPosterior(bucket: Bucket, parentProbability: number): BetaLevel {
  const alpha = PRIOR_STRENGTH * parentProbability;
  const beta = PRIOR_STRENGTH * (1 - parentProbability);
  return {
    p: (bucket.successes + alpha) / (bucket.n + alpha + beta),
    n: bucket.n,
  };
}

function selectBetaLevel(
  globalProbability: number,
  levels: BetaLevel[],
): BetaLevel {
  let selected: BetaLevel = { p: globalProbability, n: 0 };
  for (const level of levels) {
    if (level.n >= MIN_BUCKET_SAMPLE) {
      selected = level;
    } else if (level.n >= MIN_BLEND_SAMPLE) {
      selected = {
        p:
          (level.n * level.p + PRIOR_STRENGTH * selected.p) /
          (level.n + PRIOR_STRENGTH),
        n: level.n,
      };
    }
  }
  return selected;
}

function fitDurationLevel(
  bucket: Bucket,
  parent: { mu: number; sigma: number },
): DurationLevel {
  if (bucket.durations.length === 0 || bucket.n === 0) {
    return { ...parent, n: 0 };
  }

  const totalWeight = bucket.durations.reduce((sum, entry) => sum + entry.w, 0);
  if (totalWeight <= 0) return { ...parent, n: 0 };

  const mean =
    bucket.durations.reduce((sum, entry) => sum + entry.x * entry.w, 0) /
    totalWeight;
  const variance =
    bucket.durations.reduce(
      (sum, entry) => sum + entry.w * (entry.x - mean) ** 2,
      0,
    ) / totalWeight;

  const n = bucket.n;
  const mu = (n * mean + PRIOR_STRENGTH * parent.mu) / (n + PRIOR_STRENGTH);
  const sigmaSquared =
    (n * variance + PRIOR_STRENGTH * parent.sigma ** 2) /
    (n + PRIOR_STRENGTH);

  return {
    mu,
    sigma: clamp(Math.sqrt(Math.max(sigmaSquared, 0.0001)), 0.25, 1.5),
    n,
  };
}

function selectDurationLevel(
  globalLevel: DurationLevel,
  levels: DurationLevel[],
): DurationLevel {
  let selected = globalLevel;
  for (const level of levels) {
    if (level.n >= MIN_BUCKET_SAMPLE) {
      selected = level;
    } else if (level.n >= MIN_BLEND_SAMPLE) {
      selected = {
        mu:
          (level.n * level.mu + PRIOR_STRENGTH * selected.mu) /
          (level.n + PRIOR_STRENGTH),
        sigma: Math.sqrt(
          (level.n * level.sigma ** 2 + PRIOR_STRENGTH * selected.sigma ** 2) /
            (level.n + PRIOR_STRENGTH),
        ),
        n: level.n,
      };
    }
  }
  return { ...selected, sigma: clamp(selected.sigma, 0.25, 1.5) };
}

function confidenceFor(
  nEff: number,
  width: number,
  sampleSize: number,
  calibrationCount: number,
): Confidence {
  if (nEff < MIN_BUCKET_SAMPLE || width > 0.4 || sampleSize < MIN_BUCKET_SAMPLE) {
    return 'low';
  }
  if (nEff < 20 || width > 0.25) return 'medium';
  return calibrationCount >= 20 ? 'high' : 'medium';
}

function riskFor(probability: number): RiskLevel {
  if (probability < 0.45) return 'HIGH';
  if (probability < 0.7) return 'MEDIUM';
  return 'LOW';
}

function calibrateProbability(probability: number, calibration?: Calibration): number {
  if (!calibration || calibration.count < 20) return probability;
  const a = clamp(calibration.a, 0.2, 3);
  const b = clamp(calibration.b, -2, 2);
  return clamp(sigmoid(a * logit(probability) + b), 0.01, 0.99);
}

function weekdayStats(points: HistoryPoint[]) {
  const buckets = new Map<number, { n: number; successes: number }>();
  for (const point of points) {
    if (point.completedWeekday === null) continue;
    const bucket = buckets.get(point.completedWeekday) ?? { n: 0, successes: 0 };
    bucket.n += point.recencyWeight;
    bucket.successes += point.recencyWeight * point.label;
    buckets.set(point.completedWeekday, bucket);
  }
  return buckets;
}

function weekdayHourStats(points: HistoryPoint[]) {
  const buckets = new Map<
    string,
    { weekday: number; hour: number; n: number; successes: number }
  >();
  for (const point of points) {
    if (point.completedWeekday === null || point.completedHour === null) continue;
    const key = `${point.completedWeekday}-${point.completedHour}`;
    const bucket =
      buckets.get(key) ?? {
        weekday: point.completedWeekday,
        hour: point.completedHour,
        n: 0,
        successes: 0,
      };
    bucket.n += point.recencyWeight;
    bucket.successes += point.recencyWeight * point.label;
    buckets.set(key, bucket);
  }
  return buckets;
}

function buildReasons(
  target: TimeMachineTaskInput,
  points: HistoryPoint[],
  core: {
    probability: number;
    duration: DurationLevel;
    nEff: number;
  },
  workload: number,
  now: number,
): string[] {
  const reasons: string[] = [];
  const completed = points.filter((point) => point.durationDays !== null);
  const similar = points.filter((point) => point.similarity >= 0.35);
  const similarDurations = similar
    .map((point) => point.durationDays)
    .filter((value): value is number => value !== null);
  const typicalDays =
    median(similarDurations) ??
    median(
      completed
        .map((point) => point.durationDays)
        .filter((value): value is number => value !== null),
    ) ??
    logNormalQuantile(core.duration.mu, core.duration.sigma, 0);

  const due = parseDate(target.dueAt);
  if (due !== null) {
    const leadDays = Math.max(0, daysBetween(now, due));
    reasons.push(
      `Similar tasks took a median of ${round(typicalDays, 1)} days; this deadline leaves ${round(leadDays, 1)} days.`,
    );
  } else {
    reasons.push(
      'No deadline set. This is the estimated chance of finishing within 7 days.',
    );
  }

  if (similar.length >= 2) {
    const onTime = similar.filter((point) => point.label === 1).length;
    reasons.push(
      `You completed ${similar.length} similar task${similar.length === 1 ? '' : 's'} on time ${Math.round((onTime / similar.length) * 100)}% of the time.`,
    );
  }

  const weekdays = weekdayStats(points);
  let bestWeekday: { weekday: number; n: number; rate: number } | null = null;
  for (const [weekday, bucket] of weekdays) {
    if (bucket.n < 3) continue;
    const rate = bucket.successes / bucket.n;
    if (!bestWeekday || rate > bestWeekday.rate) {
      bestWeekday = { weekday, n: bucket.n, rate };
    }
  }
  if (bestWeekday && bestWeekday.rate >= 0.7) {
    reasons.push(
      `Your ${WEEKDAYS[bestWeekday.weekday]} completion rate is ${Math.round(bestWeekday.rate * 100)}% (${Math.round(bestWeekday.n)} tasks).`,
    );
  }

  if (workload >= 3) {
    reasons.push(
      `You have ${workload} open tasks due in the next 7 days, which may squeeze this one.`,
    );
  }

  if ((target.shiftCount ?? 0) > 0) {
    const shifts = target.shiftCount ?? 0;
    reasons.push(
      `This deadline has moved ${shifts} time${shifts === 1 ? '' : 's'}; rescheduled tasks are less likely to finish on time.`,
    );
  }

  if (reasons.length < 3 && core.nEff >= MIN_BUCKET_SAMPLE) {
    reasons.push(
      `Your ${priorityFor(target).toLowerCase()}-priority ${categoryFor(target)} history supports this estimate.`,
    );
  }

  return reasons.slice(0, 3);
}

function buildEvidence(points: HistoryPoint[]): PredictionEvidence[] {
  return points
    .filter((point) => point.similarity > 0.15)
    .sort(
      (a, b) =>
        b.similarity * b.recencyWeight - a.similarity * a.recencyWeight,
    )
    .slice(0, 3)
    .map((point) => ({
      taskId: point.task.id,
      text: point.task.text,
      similarity: round(point.similarity, 2),
      outcome: point.outcome === 'on_time' ? 'on_time' : point.outcome === 'late' ? 'late' : 'overdue',
      durationDays:
        point.durationDays === null ? null : round(point.durationDays, 1),
    }));
}

function scoreCore(
  target: TimeMachineTaskInput,
  points: HistoryPoint[],
  options: {
    now: number;
    calibration?: Calibration;
    workload: number;
  },
): CorePrediction {
  const buckets = makeBuckets(target, points);
  const globalP = 0.55;
  const p1 = betaPosterior(buckets.all, globalP);
  const p2 = betaPosterior(buckets.categoryPriority, p1.p);
  const p3 = betaPosterior(buckets.similar, p2.p);
  const onTime = selectBetaLevel(globalP, [p1, p2, p3]);

  const globalDuration = (() => {
    const value = durationBenchmark(priorityFor(target), categoryFor(target));
    const medianDays = Math.max(0.25, value.medianDays);
    const p85Days = Math.max(medianDays + 0.25, value.p85Days);
    return {
      mu: Math.log(medianDays),
      sigma: clamp(
        (Math.log(p85Days) - Math.log(medianDays)) / 1.0364,
        0.25,
        1.5,
      ),
    };
  })();

  const d1 = fitDurationLevel(buckets.all, globalDuration);
  const d2 = fitDurationLevel(buckets.categoryPriority, d1);
  const d3 = fitDurationLevel(buckets.similar, d2);
  const duration = selectDurationLevel(
    { ...globalDuration, n: 0 },
    [d1, d2, d3],
  );

  const due = parseDate(target.dueAt);
  const leadDays =
    due === null ? 7 : Math.max(0.01, daysBetween(options.now, due));
  const pDuration = normalCdf(
    (Math.log(Math.max(leadDays, 0.01)) - duration.mu) / duration.sigma,
  );

  const nDuration = points.filter((point) => point.durationDays !== null).length;
  const nOnTime = points.length;
  let rawProbability: number;
  if (nDuration === 0 && nOnTime === 0) {
    rawProbability = pDuration;
  } else if (nDuration === 0) {
    rawProbability = onTime.p;
  } else if (nOnTime === 0) {
    rawProbability = pDuration;
  } else {
    const weight = clamp(
      nDuration / (nDuration + nOnTime),
      0.3,
      0.7,
    );
    rawProbability = sigmoid(
      weight * logit(pDuration) + (1 - weight) * logit(onTime.p),
    );
  }
  rawProbability = clamp(rawProbability, 0.01, 0.99);
  const probability = calibrateProbability(rawProbability, options.calibration);

  const nEff = Math.max(onTime.n, duration.n);
  const baseMargin = nEff < 1 ? 0.22 : 1.2816 * Math.sqrt((probability * (1 - probability)) / (nEff + 4));
  const pLow = clamp(probability - baseMargin, 0.01, 0.99);
  const pHigh = clamp(probability + baseMargin, 0.01, 0.99);
  const width = pHigh - pLow;
  const confidence = confidenceFor(
    nEff,
    width,
    points.length,
    options.calibration?.count ?? 0,
  );

  const sampleSize = points.length;
  const mode: CorePrediction['mode'] =
    sampleSize === 0
      ? 'global'
      : nEff >= MIN_BUCKET_SAMPLE
        ? 'personal'
        : 'blended';

  const p50 = options.now + logNormalQuantile(duration.mu, duration.sigma, 0) * DAY_MS;
  const p80 =
    options.now +
    logNormalQuantile(duration.mu, duration.sigma, 0.8416) * DAY_MS;

  const core: CorePrediction = {
    probability,
    rawProbability,
    pLow,
    pHigh,
    confidence,
    sampleSize,
    mode,
    riskLevel: riskFor(probability),
    expectedCompletion: {
      p50: new Date(Math.max(options.now, p50)).toISOString(),
      p80: new Date(Math.max(options.now, p80)).toISOString(),
    },
    reasons: [],
    evidence: buildEvidence(points),
    duration,
    onTime,
    nEff,
    deadline: target.dueAt,
  };

  core.reasons = buildReasons(target, points, core, options.workload, options.now);
  return core;
}

function formatDeadline(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatWindow(weekday: number, hour: number): string {
  return `${WEEKDAYS[weekday]} at ${String(hour).padStart(2, '0')}:00`;
}

function atLocalHour(base: Date, days: number, hour: number): Date {
  const date = new Date(base.getTime() + days * DAY_MS);
  date.setHours(hour, 0, 0, 0);
  return date;
}

function nextWeekdayAt(
  now: Date,
  weekday: number,
  hour: number,
): Date | null {
  for (let offset = 0; offset <= 14; offset += 1) {
    const candidate = atLocalHour(now, offset, hour);
    if (candidate.getDay() === weekday && candidate.getTime() > now.getTime() + 3_600_000) {
      return candidate;
    }
  }
  return null;
}

function dedupeCandidates(candidates: Date[]): Date[] {
  const seen = new Set<number>();
  const result: Date[] = [];
  for (const candidate of candidates) {
    const key = Math.round(candidate.getTime() / 3_600_000);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function buildDeadlineCandidate(
  target: TimeMachineTaskInput,
  points: HistoryPoint[],
  core: CorePrediction,
  options: { now: number; calibration?: Calibration; workload: number },
): Candidate | null {
  const currentDue = parseDate(target.dueAt);
  const dates: Date[] = [];
  const now = new Date(options.now);

  const p50Days = logNormalQuantile(core.duration.mu, core.duration.sigma, 0);
  const p80Days = logNormalQuantile(core.duration.mu, core.duration.sigma, 0.8416);
  const p90Days = logNormalQuantile(core.duration.mu, core.duration.sigma, 1.2816);
  for (const days of [p50Days, p80Days, p90Days]) {
    dates.push(atLocalHour(now, Math.max(1, Math.ceil(days)), 19));
  }

  if (currentDue !== null) {
    for (const extra of [1, 3, 7]) {
      dates.push(atLocalHour(new Date(currentDue), extra, 19));
    }
  }

  const weekdays = weekdayStats(points);
  const rankedWeekdays = [...weekdays.entries()]
    .filter(([, bucket]) => bucket.n >= MIN_BUCKET_SAMPLE)
    .map(([weekday, bucket]) => ({
      weekday,
      n: bucket.n,
      rate: bucket.successes / bucket.n,
    }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 2);
  for (const entry of rankedWeekdays) {
    const next = nextWeekdayAt(now, entry.weekday, 19);
    if (next) dates.push(next);
  }

  let best: { date: Date; probability: number; score: number } | null = null;
  for (const date of dedupeCandidates(dates)) {
    if (date.getTime() <= options.now + 12 * 3_600_000) continue;
    if (date.getTime() > options.now + 60 * DAY_MS) continue;
    if (currentDue !== null && date.getTime() <= currentDue + 3_600_000) continue;

    const candidateTarget: TimeMachineTaskInput = {
      ...target,
      dueAt: date.toISOString(),
    };
    const candidateCore = scoreCore(candidateTarget, points, options);
    const lift = candidateCore.probability - core.probability;
    if (candidateCore.probability < 0.5 || lift < 0.05) continue;

    const delayDays = daysBetween(options.now, date.getTime());
    const score = candidateCore.probability - 0.002 * delayDays;
    if (!best || score > best.score) {
      best = { date, probability: candidateCore.probability, score };
    }
  }

  if (!best) return null;

  const extraDays =
    currentDue === null
      ? daysBetween(options.now, best.date.getTime())
      : daysBetween(currentDue, best.date.getTime());
  const reasons: string[] = [];
  if (currentDue !== null) {
    reasons.push(
      `Adds ${round(extraDays, 1)} days, covering more of your expected completion window.`,
    );
  } else {
    reasons.push(
      `Sets a deadline ${round(extraDays, 1)} days out, close to your expected completion time.`,
    );
  }
  if (rankedWeekdays.length > 0) {
    const bestDay = rankedWeekdays.find(
      (entry) => entry.weekday === best.date.getDay(),
    );
    if (bestDay) {
      reasons.push(
        `Aligns with ${WEEKDAYS[bestDay.weekday]}, your strongest completion weekday.`,
      );
    }
  }

  return {
    type: 'deadline_change',
    label: `Move deadline to ${formatDeadline(best.date.toISOString())}`,
    payload: { dueAt: best.date.toISOString() },
    recommendedProbability: best.probability,
    estimated: true,
    reasons,
  };
}

function buildScheduleCandidate(
  target: TimeMachineTaskInput,
  points: HistoryPoint[],
  core: CorePrediction,
  options: { now: number },
): Candidate | null {
  if (points.length === 0) return null;
  const buckets = weekdayHourStats(points);
  if (buckets.size === 0) return null;

  const ranked = [...buckets.values()].sort((a, b) => {
    if (b.n !== a.n) return b.n - a.n;
    return b.successes / b.n - a.successes / a.n;
  });
  const best = ranked[0];
  if (!best) return null;

  const now = new Date(options.now);
  const start = nextWeekdayAt(now, best.weekday, best.hour);
  if (!start) return null;

  const due = parseDate(target.dueAt);
  if (due !== null && start.getTime() >= due) return null;

  const overall = points.length;
  const overallRate =
    points.reduce((sum, point) => sum + point.label, 0) / Math.max(1, overall);
  const bucketRate = best.successes / best.n;
  const delta = clamp(
    (bucketRate - overallRate) * (best.n / (best.n + 20)),
    -0.2,
    0.2,
  );

  const hasEnough = best.n >= MIN_BUCKET_SAMPLE;
  const estimated = hasEnough && delta >= 0.03;
  const recommendedProbability = estimated
    ? clamp(core.probability + delta, 0.01, 0.99)
    : core.probability;

  return {
    type: 'schedule_window',
    label: `Schedule a 2-hour block on ${formatWindow(best.weekday, best.hour)}`,
    payload: { scheduledStartAt: start.toISOString() },
    recommendedProbability,
    estimated,
    reasons: estimated
      ? [
          `You complete tasks in this window ${Math.round(bucketRate * 100)}% on time (${Math.round(best.n)} tasks).`,
        ]
      : [
          'Try a focused work block; there is not enough history for a numeric estimate yet.',
        ],
  };
}

function splitCheckpoints(text: string): string[] {
  const clauses = text
    .split(/[,;]|\band\b|\bthen\b/gi)
    .map((value) => value.trim())
    .filter((value) => value.length > 2)
    .slice(0, 4);
  if (clauses.length >= 2) {
    return clauses.map((value) => {
      const capitalized = value.charAt(0).toUpperCase() + value.slice(1);
      return `Checkpoint: ${capitalized}`;
    });
  }
  return ['Start', 'Midpoint', 'Finish'];
}

function buildSubtasksCandidate(
  target: TimeMachineTaskInput,
  points: HistoryPoint[],
  core: CorePrediction,
): Candidate | null {
  const expectedDays = logNormalQuantile(core.duration.mu, core.duration.sigma, 0);
  const multiClause = /[,;]|\band\b|\bthen\b/i.test(target.text);
  if (expectedDays < 7 && !multiClause) return null;

  const checkpoints = splitCheckpoints(target.text);
  const withMilestones = points.filter(
    (point) => (point.task.milestones?.length ?? 0) >= 2,
  );
  const withoutMilestones = points.filter(
    (point) => (point.task.milestones?.length ?? 0) < 2,
  );

  let estimated = false;
  let recommendedProbability = core.probability;
  let reason =
    'Break the work into smaller steps; a numeric estimate is still pending.';

  if (
    withMilestones.length >= MIN_BUCKET_SAMPLE &&
    withoutMilestones.length >= MIN_BUCKET_SAMPLE
  ) {
    const withRate =
      withMilestones.filter((point) => point.label === 1).length /
      withMilestones.length;
    const withoutRate =
      withoutMilestones.filter((point) => point.label === 1).length /
      withoutMilestones.length;
    const delta = clamp(
      (withRate - withoutRate) *
        (withMilestones.length / (withMilestones.length + 20)),
      -0.15,
      0.15,
    );
    if (delta >= 0.02) {
      estimated = true;
      recommendedProbability = clamp(core.probability + delta, 0.01, 0.99);
      reason = `Tasks with checkpoints are completed on time ${Math.round(withRate * 100)}% of the time (${withMilestones.length} tasks).`;
    }
  }

  return {
    type: 'split_subtasks',
    label: `Split into ${checkpoints.length} checkpoints`,
    payload: { milestones: checkpoints },
    recommendedProbability,
    estimated,
    reasons: [reason],
  };
}

function buildReminderCandidate(
  target: TimeMachineTaskInput,
  points: HistoryPoint[],
  core: CorePrediction,
  options: { now: number },
): Candidate | null {
  const now = new Date(options.now);
  const due = parseDate(target.dueAt);
  let remindAt: Date;
  let label: string;

  if (due !== null) {
    const dayBefore = new Date(due - DAY_MS);
    if (dayBefore.getTime() > options.now + 3_600_000) {
      remindAt = dayBefore;
      label = 'Remind me 24 hours before the deadline';
    } else {
      const morning = new Date(due);
      morning.setHours(9, 0, 0, 0);
      if (morning.getTime() <= options.now) {
        remindAt = new Date(options.now + 2 * 3_600_000);
      } else {
        remindAt = morning;
      }
      label = 'Remind me on the morning of the deadline';
    }
  } else {
    remindAt = atLocalHour(now, 1, 9);
    label = 'Remind me tomorrow morning';
  }

  const withReminders = points.filter((point) => point.task.reminderAt);
  const withoutReminders = points.filter((point) => !point.task.reminderAt);
  let estimated = false;
  let recommendedProbability = core.probability;
  let reason = 'A reminder can keep this task visible; a numeric estimate is still pending.';

  if (
    withReminders.length >= MIN_BUCKET_SAMPLE &&
    withoutReminders.length >= MIN_BUCKET_SAMPLE
  ) {
    const withRate =
      withReminders.filter((point) => point.label === 1).length /
      withReminders.length;
    const withoutRate =
      withoutReminders.filter((point) => point.label === 1).length /
      withoutReminders.length;
    const delta = clamp(
      (withRate - withoutRate) *
        (withReminders.length / (withReminders.length + 20)),
      -0.15,
      0.15,
    );
    if (delta >= 0.02) {
      estimated = true;
      recommendedProbability = clamp(core.probability + delta, 0.01, 0.99);
      reason = `Tasks with reminders are completed on time ${Math.round(withRate * 100)}% of the time (${withReminders.length} tasks).`;
    }
  }

  return {
    type: 'reminder',
    label,
    payload: { reminderAt: remindAt.toISOString() },
    recommendedProbability,
    estimated,
    reasons: [reason],
  };
}

function buildRecurrenceCandidate(
  target: TimeMachineTaskInput,
  points: HistoryPoint[],
): Candidate | null {
  const similar = points
    .filter(
      (point) =>
        point.similarity >= 0.55 &&
        point.durationDays !== null &&
        point.task.completedAt,
    )
    .sort(
      (a, b) =>
        (parseDate(a.task.completedAt) ?? 0) -
        (parseDate(b.task.completedAt) ?? 0),
    );
  if (similar.length < 3) return null;

  const times = similar
    .map((point) => parseDate(point.task.completedAt))
    .filter((value): value is number => value !== null);
  if (times.length < 3) return null;

  const intervals: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    intervals.push(daysBetween(times[index - 1], times[index]));
  }
  if (intervals.length < 2) return null;

  const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  if (mean <= 0) return null;
  const variance =
    intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    intervals.length;
  const cv = Math.sqrt(variance) / mean;
  if (cv > 0.25) return null;

  const period = Math.round(mean);
  const weekdays = similar
    .map((point) => point.completedWeekday)
    .filter((value): value is number => value !== null);
  const dominantWeekday = weekdays.length
    ? weekdays.sort(
        (a, b) =>
          weekdays.filter((value) => value === b).length -
          weekdays.filter((value) => value === a).length,
      )[0]
    : null;

  let rrule: string;
  let cadence: string;
  if (period === 7 || (period >= 6 && period <= 8)) {
    rrule = `FREQ=WEEKLY${dominantWeekday === null ? '' : `;BYDAY=${RRULE_DAYS[dominantWeekday]}`}`;
    cadence = 'weekly';
  } else if (period === 14 || (period >= 13 && period <= 15)) {
    rrule = `FREQ=WEEKLY;INTERVAL=2${dominantWeekday === null ? '' : `;BYDAY=${RRULE_DAYS[dominantWeekday]}`}`;
    cadence = 'every two weeks';
  } else if (period === 30 || (period >= 28 && period <= 31)) {
    rrule = 'FREQ=MONTHLY';
    cadence = 'monthly';
  } else if (period === 1) {
    rrule = 'FREQ=DAILY';
    cadence = 'daily';
  } else {
    return null;
  }

  return {
    type: 'recurrence_series',
    label: `Create a ${cadence} recurring series`,
    payload: { rrule, title: target.text },
    recommendedProbability: 0.5,
    estimated: false,
    reasons: [
      `You completed ${similar.length} similar tasks about every ${period} day${period === 1 ? '' : 's'}.`,
    ],
  };
}

function recommendationId(
  taskId: string,
  type: RecommendationType,
  payload: TimeMachineRecommendation['payload'],
): string {
  return `rec_${taskId}_${type}_${hashShort(JSON.stringify(payload))}`;
}

function buildRecommendations(
  target: TimeMachineTaskInput,
  points: HistoryPoint[],
  core: CorePrediction,
  options: {
    now: number;
    calibration?: Calibration;
    workload: number;
    dismissedTypes: Set<RecommendationType>;
  },
): TimeMachineRecommendation[] {
  if (core.probability >= 0.85) return [];

  const candidates: Candidate[] = [];
  const deadline = buildDeadlineCandidate(target, points, core, options);
  if (deadline) candidates.push(deadline);
  const schedule = buildScheduleCandidate(target, points, core, options);
  if (schedule) candidates.push(schedule);
  const subtasks = buildSubtasksCandidate(target, points, core);
  if (subtasks) candidates.push(subtasks);
  const reminder = buildReminderCandidate(target, points, core, options);
  if (reminder) candidates.push(reminder);
  const recurrence = buildRecurrenceCandidate(target, points);
  if (recurrence) candidates.push(recurrence);

  const ranked = candidates
    .filter((candidate) => !options.dismissedTypes.has(candidate.type))
    .sort((a, b) => {
      const aScore = a.estimated ? a.recommendedProbability - core.probability : 0;
      const bScore = b.estimated ? b.recommendedProbability - core.probability : 0;
      if (aScore !== bScore) return bScore - aScore;
      return a.type.localeCompare(b.type);
    })
    .slice(0, MAX_RECOMMENDATIONS);

  const taskId = target.id ?? 'preview';
  return ranked.map((candidate) => ({
    id: recommendationId(taskId, candidate.type, candidate.payload),
    type: candidate.type,
    label: candidate.label,
    payload: candidate.payload,
    baselineProbability: round(core.probability),
    recommendedProbability: round(candidate.recommendedProbability),
    lift: round(candidate.recommendedProbability - core.probability),
    confidence: core.confidence,
    estimated: candidate.estimated,
    reasons: candidate.reasons,
  }));
}

/**
 * Pure Time Machine prediction and recommendation builder. It never reads a
 * database or another user's data; callers pass only the owner's history.
 */
export function buildTimeMachine(
  target: TimeMachineTaskInput,
  history: TimeMachineHistoryTask[],
  options: TimeMachineOptions = {},
): TimeMachineResponse {
  const nowDate = options.now ?? new Date();
  const now = nowDate.getTime();
  const points = buildPoints(target, history, now);
  const workload = history.filter((task) => {
    if (task.done) return false;
    const due = parseDate(task.dueAt);
    return due !== null && due >= now && due <= now + 7 * DAY_MS;
  }).length;

  const core = scoreCore(target, points, {
    now,
    calibration: options.calibration,
    workload,
  });

  const dismissedTypes = new Set<RecommendationType>(options.dismissedTypes ?? []);
  const recommendations =
    options.includeRecommendations === false ||
    options.holdout ||
    options.teamTask ||
    target.done
      ? []
      : buildRecommendations(target, points, core, {
          now,
          calibration: options.calibration,
          workload,
          dismissedTypes,
        });

  const baseline: TimeMachineBaseline = {
    completionProbability: round(core.probability),
    interval: [round(core.pLow), round(core.pHigh)],
    deadline: target.dueAt,
    expectedCompletion: core.expectedCompletion,
    riskLevel: core.riskLevel,
    confidence: core.confidence,
    sampleSize: core.sampleSize,
    mode: core.mode,
    reasons: core.reasons,
    evidence: core.evidence,
  };

  return {
    taskId: target.id ?? 'preview',
    generatedAt: nowDate.toISOString(),
    model: {
      version: TIME_MACHINE_MODEL_VERSION,
      mode: core.mode,
      sampleSize: core.sampleSize,
      confidence: core.confidence,
    },
    baseline,
    recommendations,
    holdout: options.holdout ?? false,
  };
}

/**
 * Fit Platt scaling (a * logit(p) + b) with decay weights and L2
 * regularization. Used by the nightly/user-triggered calibration path.
 */
export function fitCalibration(
  samples: Array<{ probability: number; label: 0 | 1; ageDays: number }>,
): Calibration | null {
  if (samples.length < 20) return null;

  let a = 1;
  let b = 0;
  const learningRate = 0.08;
  const iterations = 250;
  const regularization = 0.01;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let gradientA = 0;
    let gradientB = 0;
    let totalWeight = 0;

    for (const sample of samples) {
      const weight = 0.5 ** (Math.max(0, sample.ageDays) / RECENCY_HALF_LIFE_DAYS);
      const x = logit(sample.probability);
      const predicted = sigmoid(a * x + b);
      const error = predicted - sample.label;
      gradientA += weight * error * x;
      gradientB += weight * error;
      totalWeight += weight;
    }

    if (totalWeight === 0) return null;
    gradientA = gradientA / totalWeight + regularization * a;
    gradientB = gradientB / totalWeight + regularization * b;
    a -= learningRate * gradientA;
    b -= learningRate * gradientB;
    a = clamp(a, 0.2, 3);
    b = clamp(b, -2, 2);
  }

  return { a: round(a, 4), b: round(b, 4), count: samples.length };
}

export function brierScore(
  samples: Array<{ probability: number; label: 0 | 1 }>,
): number | null {
  if (samples.length === 0) return null;
  return round(
    samples.reduce(
      (sum, sample) => sum + (sample.probability - sample.label) ** 2,
      0,
    ) / samples.length,
    4,
  );
}

export function expectedCalibrationError(
  samples: Array<{ probability: number; label: 0 | 1 }>,
): number | null {
  if (samples.length === 0) return null;
  const bins = Array.from({ length: 10 }, () => ({ count: 0, predicted: 0, actual: 0 }));
  for (const sample of samples) {
    const index = Math.min(9, Math.max(0, Math.floor(sample.probability * 10)));
    const bin = bins[index];
    bin.count += 1;
    bin.predicted += sample.probability;
    bin.actual += sample.label;
  }
  return round(
    bins.reduce((sum, bin) => {
      if (bin.count === 0) return sum;
      return (
        sum +
        (bin.count / samples.length) *
          Math.abs(bin.predicted / bin.count - bin.actual / bin.count)
      );
    }, 0),
    4,
  );
}
