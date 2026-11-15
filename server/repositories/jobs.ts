import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.ts';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'dead';

export interface JobRecord {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  runAt: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
}

interface JobRow extends Record<string, unknown> {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  run_at: Date | string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    runAt: toIso(row.run_at),
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
  };
}

export async function enqueueJob(
  db: Db,
  input: {
    type: string;
    payload?: Record<string, unknown>;
    runAt?: string;
    maxAttempts?: number;
  },
): Promise<JobRecord> {
  const rows = await db.query<JobRow>(
    `insert into jobs (id, type, payload, run_at, max_attempts)
     values ($1, $2, $3::jsonb, coalesce($4::timestamptz, now()), $5)
     returning id, type, payload, run_at, status, attempts, max_attempts, last_error`,
    [
      randomUUID(),
      input.type,
      JSON.stringify(input.payload ?? {}),
      input.runAt ?? null,
      input.maxAttempts ?? 5,
    ],
  );
  if (!rows[0]) throw new Error('Job insert did not return a row.');
  return toJob(rows[0]);
}

/**
 * Claim the oldest ready job. PGlite is single-connection, so a serial
 * select-for-update is sufficient locally. Postgres deployments should use
 * `for update skip locked` once the runner is multi-instance.
 */
export async function claimNextJob(
  db: Db,
  workerId: string,
): Promise<JobRecord | null> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<JobRow>(
      `select id, type, payload, run_at, status, attempts, max_attempts, last_error
         from jobs
        where status = 'pending' and run_at <= now()
        order by run_at asc
        limit 1
        for update`,
    );
    const row = rows[0];
    if (!row) return null;
    const updated = await tx.query<JobRow>(
      `update jobs
          set status = 'running', locked_by = $2, locked_at = now(), attempts = attempts + 1
        where id = $1
        returning id, type, payload, run_at, status, attempts, max_attempts, last_error`,
      [row.id, workerId],
    );
    return updated[0] ? toJob(updated[0]) : null;
  });
}

export async function completeJob(db: Db, id: string): Promise<void> {
  await db.query(
    `update jobs
        set status = 'done', finished_at = now(), locked_by = null, locked_at = null
      where id = $1`,
    [id],
  );
}

export async function failJob(
  db: Db,
  id: string,
  error: string,
): Promise<void> {
  await db.query(
    `update jobs
        set status = case when attempts >= max_attempts then 'dead' else 'pending' end,
            last_error = $2,
            run_at = case when attempts >= max_attempts then run_at else now() + interval '1 minute' end,
            locked_by = null,
            locked_at = null,
            finished_at = case when attempts >= max_attempts then now() else null end
      where id = $1`,
    [id, error.slice(0, 2000)],
  );
}
