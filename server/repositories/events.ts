import type { Db, DbExecutor } from '../db/client.ts';

export interface TaskEventInput {
  taskId: string;
  userId: string;
  actorUserId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
  occurredAt?: string;
}

export interface TaskEventRecord {
  id: string;
  taskId: string;
  userId: string;
  actorUserId: string | null;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

interface TaskEventRow extends Record<string, unknown> {
  id: string | number;
  task_id: string;
  user_id: string;
  actor_user_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  occurred_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function insertTaskEvent(
  db: DbExecutor,
  event: TaskEventInput,
): Promise<void> {
  await db.query(
    `insert into task_events
       (task_id, user_id, actor_user_id, type, payload, occurred_at)
     values ($1, $2, $3, $4, $5::jsonb, coalesce($6::timestamptz, now()))`,
    [
      event.taskId,
      event.userId,
      event.actorUserId ?? event.userId,
      event.type,
      JSON.stringify(event.payload ?? {}),
      event.occurredAt ?? null,
    ],
  );
}

export async function listTaskEvents(
  db: Db,
  taskId: string,
  userId: string,
): Promise<TaskEventRecord[]> {
  const rows = await db.query<TaskEventRow>(
    `select id, task_id, user_id, actor_user_id, type, payload, occurred_at
       from task_events
      where task_id = $1 and user_id = $2
      order by occurred_at asc, id asc`,
    [taskId, userId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    taskId: row.task_id,
    userId: row.user_id,
    actorUserId: row.actor_user_id,
    type: row.type,
    payload: row.payload,
    occurredAt: toIso(row.occurred_at),
  }));
}
