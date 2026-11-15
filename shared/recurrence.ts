/**
 * Recurrence helpers shared by the API and the UI.
 *
 * The app stores a small, explicit subset of iCalendar RRULE:
 *   FREQ=DAILY|WEEKLY|MONTHLY[;INTERVAL=n][;BYDAY=MO,WE]
 *
 * Occurrences are computed in UTC. The series `timezone` is stored for display
 * and future calendar integration; it does not shift occurrence times yet.
 */

const DAY_MS = 86_400_000;
const RRULE_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export interface ParsedRrule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  /** 0 = Sunday … 6 = Saturday. Empty when the rule has no BYDAY. */
  byDay: number[];
}

function isWeeklyDay(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 6;
}

/** Parse the supported RRULE subset. Returns null for anything unsupported. */
export function parseRrule(value: string): ParsedRrule | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts = value.trim().toUpperCase().split(';');
  const fields = new Map<string, string>();
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index <= 0) return null;
    const key = part.slice(0, index);
    const raw = part.slice(index + 1);
    if (!key || !raw) return null;
    fields.set(key, raw);
  }

  const freq = fields.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return null;

  const interval = Number(fields.get('INTERVAL') ?? '1');
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) return null;

  const byDay: number[] = [];
  const dayList = fields.get('BYDAY');
  if (dayList) {
    if (freq !== 'WEEKLY') return null;
    for (const token of dayList.split(',')) {
      const day = RRULE_DAYS.indexOf(token);
      if (day === -1) return null;
      if (!byDay.includes(day)) byDay.push(day);
    }
    if (byDay.length === 0) return null;
  }

  return { freq, interval, byDay };
}

/** Uppercase and trim a rule so equal rules compare equal. */
export function canonicalRrule(value: string): string | null {
  const parsed = parseRrule(value);
  if (!parsed) return null;
  const byDay = parsed.byDay
    .slice()
    .sort((a, b) => a - b)
    .map((day) => RRULE_DAYS[day])
    .join(',');
  return `FREQ=${parsed.freq}${parsed.interval === 1 ? '' : `;INTERVAL=${parsed.interval}`}${byDay ? `;BYDAY=${byDay}` : ''}`;
}

/** Human label for a rule, e.g. "every two weeks on Monday". */
export function describeRrule(value: string): string {
  const rule = parseRrule(value);
  if (!rule) return 'custom schedule';
  const dayLabel =
    rule.byDay.length === 1 ? ` on ${DAY_NAMES[rule.byDay[0]]}` : '';
  if (rule.freq === 'DAILY') {
    return rule.interval === 1 ? 'every day' : `every ${rule.interval} days`;
  }
  if (rule.freq === 'MONTHLY') {
    return rule.interval === 1 ? 'every month' : `every ${rule.interval} months`;
  }
  if (rule.interval === 1) return `every week${dayLabel}`;
  if (rule.interval === 2) return `every two weeks${dayLabel}`;
  return `every ${rule.interval} weeks${dayLabel}`;
}

/** Approximate period of a rule in days (used for suggestion copy). */
export function rrulePeriodDays(value: string): number | null {
  const rule = parseRrule(value);
  if (!rule) return null;
  if (rule.freq === 'DAILY') return rule.interval;
  if (rule.freq === 'WEEKLY') return 7 * rule.interval;
  return 30 * rule.interval;
}

/** Normalized key used to match a series to its tasks. */
export function normalizeSeriesTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function weekStart(date: Date): Date {
  const start = new Date(date.getTime());
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  return start;
}

function advance(rule: ParsedRrule, from: Date): Date {
  if (rule.freq === 'DAILY') {
    return new Date(from.getTime() + rule.interval * DAY_MS);
  }

  if (rule.freq === 'MONTHLY') {
    const day = from.getUTCDate();
    const target = new Date(from.getTime());
    target.setUTCDate(1);
    target.setUTCMonth(target.getUTCMonth() + rule.interval);
    const lastDay = new Date(
      Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
    ).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return target;
  }

  const days = rule.byDay.length > 0 ? rule.byDay : [from.getUTCDay()];
  const anchor = weekStart(from).getTime();
  const limit = 7 * rule.interval + 7;
  for (let step = 1; step <= limit; step += 1) {
    const candidate = new Date(from.getTime() + step * DAY_MS);
    const week = Math.round(
      (weekStart(candidate).getTime() - anchor) / (7 * DAY_MS),
    );
    if (isWeeklyDay(candidate.getUTCDay()) && week % rule.interval === 0) {
      if (days.includes(candidate.getUTCDay())) return candidate;
    }
  }
  return new Date(from.getTime() + 7 * rule.interval * DAY_MS);
}

/**
 * First occurrence strictly after `after`. Returns null when the rule is
 * invalid, so callers can surface a validation error instead of guessing.
 */
export function nextOccurrence(value: string, after: Date): Date | null {
  const rule = parseRrule(value);
  if (!rule || Number.isNaN(after.getTime())) return null;
  return advance(rule, after);
}

/** Move an occurrence to 09:00 UTC on its calendar day. */
export function atNineUtc(date: Date): Date {
  const next = new Date(date.getTime());
  next.setUTCHours(9, 0, 0, 0);
  return next;
}
