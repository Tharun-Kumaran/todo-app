import type { Task } from '../shared/types';
import {
  atNineUtc,
  describeRrule,
  nextOccurrence,
  normalizeSeriesTitle,
} from '../shared/recurrence.ts';

const DAY_MS = 86_400_000;
const MIN_OCCURRENCES = 3;
const MAX_INTERVAL_CV = 0.25;
const MIN_TITLE_LENGTH = 3;
const DEFAULT_HOUR_UTC = 9;

export interface DetectedPattern {
  /** Display title, taken from the most recent completion. */
  title: string;
  /** Normalized comparison key. */
  key: string;
  rrule: string;
  cadence: string;
  sampleCount: number;
  confidence: number;
  lastCompletedAt: string;
  /** Next occurrence after the last completion, at 09:00 UTC. */
  nextAt: string;
}

function completionTimes(tasks: Task[]): number[] {
  return tasks
    .map((task) => (task.completedAt ? Date.parse(task.completedAt) : NaN))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function coefficientOfVariation(values: number[]): number {
  const average = mean(values);
  if (average <= 0) return Number.POSITIVE_INFINITY;
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    values.length;
  return Math.sqrt(variance) / average;
}

function dominantWeekday(times: number[]): number {
  const counts = new Map<number, number>();
  for (const time of times) {
    const day = new Date(time).getUTCDay();
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = -1;
  for (const [day, count] of counts) {
    if (count > bestCount || (count === bestCount && day < best)) {
      best = day;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Map an average completion interval to a supported RRULE.
 *
 * Returns null when the interval does not resemble a daily, weekly,
 * two-weekly, or monthly cadence.
 */
function ruleForPeriod(periodDays: number, weekday: number): string | null {
  if (periodDays >= 0.5 && periodDays <= 1.5) return 'FREQ=DAILY';
  if (periodDays >= 6 && periodDays <= 8) {
    return `FREQ=WEEKLY;BYDAY=${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][weekday]}`;
  }
  if (periodDays >= 13 && periodDays <= 15) {
    return `FREQ=WEEKLY;INTERVAL=2;BYDAY=${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][weekday]}`;
  }
  if (periodDays >= 28 && periodDays <= 31) return 'FREQ=MONTHLY';
  return null;
}

/**
 * Find personal tasks that keep recurring on a regular cadence.
 *
 * Only completed personal tasks count. A pattern needs at least three
 * occurrences, an interval coefficient of variation of 0.25 or lower, and a
 * period that maps to one of the supported rules.
 */
export function detectRecurringPatterns(tasks: Task[]): DetectedPattern[] {
  const groups = new Map<string, Task[]>();

  for (const task of tasks) {
    if (!task.done || !task.completedAt || task.teamId) continue;
    const key = normalizeSeriesTitle(task.text);
    if (key.length < MIN_TITLE_LENGTH) continue;
    const list = groups.get(key) ?? [];
    list.push(task);
    groups.set(key, list);
  }

  const detected: DetectedPattern[] = [];

  for (const [key, group] of groups) {
    if (group.length < MIN_OCCURRENCES) continue;

    const times = completionTimes(group);
    if (times.length < MIN_OCCURRENCES) continue;

    const intervals: number[] = [];
    for (let index = 1; index < times.length; index += 1) {
      intervals.push((times[index] - times[index - 1]) / DAY_MS);
    }

    const rule = ruleForPeriod(mean(intervals), dominantWeekday(times));
    if (!rule) continue;

    const cv = coefficientOfVariation(intervals);
    if (!Number.isFinite(cv) || cv > MAX_INTERVAL_CV) continue;

    const latest = group
      .slice()
      .sort(
        (a, b) =>
          Date.parse(b.completedAt ?? '0') - Date.parse(a.completedAt ?? '0'),
      )[0];
    const lastCompletedAt = new Date(times[times.length - 1]);
    const after = new Date(lastCompletedAt.getTime());
    after.setUTCHours(DEFAULT_HOUR_UTC, 0, 0, 0);
    const next = nextOccurrence(rule, after) ?? after;

    const confidence = Math.max(
      0,
      Math.min(1, (1 - cv) * Math.min(1, times.length / 4)),
    );

    detected.push({
      title: latest.text.trim().slice(0, 500),
      key,
      rrule: rule,
      cadence: describeRrule(rule),
      sampleCount: times.length,
      confidence: Math.round(confidence * 1000) / 1000,
      lastCompletedAt: lastCompletedAt.toISOString(),
      nextAt: atNineUtc(next).toISOString(),
    });
  }

  return detected.sort((a, b) => b.sampleCount - a.sampleCount);
}
