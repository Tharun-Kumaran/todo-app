export type DueTone = 'overdue' | 'soon' | 'normal' | 'done';

export interface DueInfo {
  label: string;
  tone: DueTone;
  title: string;
}

/** Human-friendly deadline label plus a tone used for colouring the badge. */
export function describeDue(dueAt: string | null, done: boolean): DueInfo | null {
  if (!dueAt) return null;
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return null;

  const now = new Date();
  const diff = date.getTime() - now.getTime();
  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  const title = date.toLocaleString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round(
    (startOfDay(date) - startOfDay(now)) / 86_400_000,
  );

  if (done) {
    return { label: `Due ${shortDate(date, now, days)}, ${time}`, tone: 'done', title };
  }

  if (diff < 0) {
    return { label: `Overdue by ${relativePast(-diff)}`, tone: 'overdue', title };
  }

  if (diff < 60_000) {
    return { label: 'Due now', tone: 'soon', title };
  }

  if (days === 0 && diff < 3_600_000) {
    const minutes = Math.max(1, Math.round(diff / 60_000));
    return { label: `Due in ${minutes}m`, tone: 'soon', title };
  }

  if (days === 0) {
    return { label: `Due today, ${time}`, tone: 'soon', title };
  }

  if (days === 1) {
    return { label: `Due tomorrow, ${time}`, tone: 'soon', title };
  }

  return {
    label: `Due ${shortDate(date, now, days)}, ${time}`,
    tone: days < 7 ? 'soon' : 'normal',
    title,
  };
}

function shortDate(date: Date, now: Date, days: number): string {
  const weekday = days < 7 ? date.toLocaleDateString(undefined, { weekday: 'short' }) : '';
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return weekday ? `${weekday}, ${day}` : day;
}

function relativePast(ms: number): string {
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatMilestoneTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** ISO timestamp -> value for an <input type="datetime-local">. */
export function toDateTimeLocal(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** <input type="datetime-local"> value -> ISO timestamp (or null). */
export function fromDateTimeLocal(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Combine <input type="date"> and <input type="time"> values into ISO. */
export function composeDueAt(dateValue: string, timeValue: string): string | null {
  if (!dateValue) return null;
  const date = new Date(`${dateValue}T${timeValue || '23:59'}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
