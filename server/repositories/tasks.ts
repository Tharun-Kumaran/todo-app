import { randomUUID } from 'node:crypto';
import type {
  Milestone,
  Priority,
  Task,
  TaskCategory,
} from '../../shared/types';
import type { Db, DbExecutor } from '../db/client.ts';
import { insertTaskEvent, type TaskEventInput } from './events.ts';

export interface TaskPatch {
  text?: string;
  done?: boolean;
  dueAt?: string | null;
  priority?: Priority | null;
  category?: TaskCategory | null;
  progress?: number;
  assigneeEmail?: string | null;
  scheduledStartAt?: string | null;
  reminderAt?: string | null;
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  team_id: string | null;
  creator_email: string | null;
  assignee_email: string | null;
  text: string;
  done: boolean;
  progress: number;
  priority: Priority | null;
  category: TaskCategory | null;
  due_at: Date | string | null;
  scheduled_start_at: Date | string | null;
  reminder_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
  sort_order: number;
  source: string | null;
  series_id: string | null;
  occurrence_at: Date | string | null;
}

interface MilestoneRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  text: string;
  progress: number;
  created_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function clamp(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function placeholders(count: number, start = 1): string {
  return Array.from({ length: count }, (_, index) => `$${start + index}`).join(', ');
}

function toMilestone(row: MilestoneRow): Milestone {
  return {
    id: row.id,
    text: row.text,
    // PGlite returns integer columns as strings in some builds; normalize so
    // comparisons against application numbers do not emit phantom events.
    progress: Number(row.progress),
    createdAt: toIso(row.created_at),
  };
}

function toTask(row: TaskRow, milestones: Milestone[]): Task {
  return {
    id: row.id,
    userId: row.user_id,
    creatorEmail: row.creator_email,
    teamId: row.team_id,
    assigneeEmail: row.assignee_email,
    text: row.text,
    done: row.done,
    progress: Number(row.progress),
    priority: row.priority ?? 'Medium',
    category: row.category,
    dueAt: toNullableIso(row.due_at),
    scheduledStartAt: toNullableIso(row.scheduled_start_at),
    reminderAt: toNullableIso(row.reminder_at),
    completedAt: toNullableIso(row.completed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: Number(row.version),
    milestones,
    source:
      row.source === 'recurrence' || row.source === 'import'
        ? row.source
        : 'manual',
    seriesId: row.series_id,
    occurrenceAt: toNullableIso(row.occurrence_at),
  };
}

async function loadMilestones(
  db: DbExecutor,
  taskIds: string[],
): Promise<Map<string, Milestone[]>> {
  const map = new Map<string, Milestone[]>();
  if (taskIds.length === 0) return map;
  const rows = await db.query<MilestoneRow>(
    `select id, task_id, text, progress, created_at
       from task_milestones
      where task_id in (${placeholders(taskIds.length)})
      order by created_at asc, id asc`,
    taskIds,
  );
  for (const row of rows) {
    const list = map.get(row.task_id) ?? [];
    list.push(toMilestone(row));
    map.set(row.task_id, list);
  }
  return map;
}

async function mapRows(
  db: DbExecutor,
  rows: TaskRow[],
): Promise<Task[]> {
  const milestones = await loadMilestones(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toTask(row, milestones.get(row.id) ?? []));
}

const TASK_COLUMNS = `
  id, user_id, team_id, creator_email, assignee_email, text, done, progress,
  priority, category, due_at, scheduled_start_at, reminder_at, completed_at,
  created_at, updated_at, version, sort_order, source, series_id, occurrence_at
`;

function scopeSql(
  userId: string,
  teamId?: string | null,
  teamIds?: string[],
): { sql: string; params: unknown[] } {
  if (teamId) {
    return { sql: 'team_id = $1 and deleted_at is null', params: [teamId] };
  }
  if (teamIds && teamIds.length > 0) {
    return {
      sql: `deleted_at is null and (team_id in (${placeholders(teamIds.length, 2)}) or (user_id = $1 and team_id is null))`,
      params: [userId, ...teamIds],
    };
  }
  return {
    sql: 'user_id = $1 and team_id is null and deleted_at is null',
    params: [userId],
  };
}

export async function listTasksForUser(
  db: Db,
  userId: string,
  teamId?: string | null,
): Promise<Task[]> {
  const scope = scopeSql(userId, teamId);
  const rows = await db.query<TaskRow>(
    `select ${TASK_COLUMNS} from tasks
      where ${scope.sql}
      order by sort_order asc, created_at desc`,
    scope.params,
  );
  return mapRows(db, rows);
}

export async function countTasksForUser(
  db: Db,
  userId: string,
  teamId?: string | null,
): Promise<number> {
  const scope = scopeSql(userId, teamId);
  const rows = await db.query<{ count: number | string }>(
    `select count(*)::int as count from tasks where ${scope.sql}`,
    scope.params,
  );
  return Number(rows[0]?.count ?? 0);
}

export async function getTaskForUser(
  db: Db,
  userId: string,
  id: string,
  teamIds: string[] = [],
): Promise<Task | null> {
  const scope = scopeSql(userId, null, teamIds);
  const rows = await db.query<TaskRow>(
    `select ${TASK_COLUMNS} from tasks
      where id = $1 and ${scope.sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 1}`)}`,
    [id, ...scope.params],
  );
  if (!rows[0]) return null;
  const [task] = await mapRows(db, rows);
  return task ?? null;
}

function canAccess(row: TaskRow, userId: string, teamIds: string[]): boolean {
  return row.team_id === null
    ? row.user_id === userId
    : teamIds.includes(row.team_id);
}

export async function createTask(
  db: Db,
  task: Task,
): Promise<Task> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<TaskRow>(
      `insert into tasks
         (id, user_id, team_id, creator_email, assignee_email, text, done,
          progress, priority, category, due_at, scheduled_start_at,
          reminder_at, completed_at, created_at, updated_at, version, sort_order,
          source, series_id, occurrence_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz,
               $12::timestamptz, $13::timestamptz, $14::timestamptz,
               $15::timestamptz, $16::timestamptz, $17,
               coalesce((select min(sort_order) - 1 from tasks
                          where user_id = $2
                            and team_id is not distinct from $3
                            and deleted_at is null), 0),
               $18, $19::uuid, $20::timestamptz)
       returning ${TASK_COLUMNS}`,
      [
        task.id,
        task.userId,
        task.teamId,
        task.creatorEmail,
        task.assigneeEmail,
        task.text,
        task.done,
        task.progress,
        task.priority,
        task.category,
        task.dueAt,
        task.scheduledStartAt,
        task.reminderAt,
        task.completedAt,
        task.createdAt,
        task.updatedAt,
        task.version,
        task.source ?? 'manual',
        task.seriesId ?? null,
        task.occurrenceAt ?? null,
      ],
    );
    await insertTaskEvent(tx, {
      taskId: task.id,
      userId: task.userId,
      actorUserId: task.userId,
      type: 'task.created',
      payload: {
        dueAt: task.dueAt,
        priority: task.priority,
        category: task.category,
        source: task.source ?? 'manual',
        ...(task.seriesId
          ? { seriesId: task.seriesId, occurrenceAt: task.occurrenceAt ?? null }
          : {}),
      },
      occurredAt: task.createdAt,
    });
    return toTask(rows[0], []);
  });
}

/**
 * True when this series already produced a task for the occurrence, including
 * tasks the user later deleted. Deleted rows still block duplicates.
 */
export async function hasSeriesOccurrence(
  db: Db,
  seriesId: string,
  occurrenceAt: string,
): Promise<boolean> {
  const rows = await db.query(
    `select 1 from tasks
      where series_id = $1 and occurrence_at = $2::timestamptz
      limit 1`,
    [seriesId, occurrenceAt],
  );
  return rows.length > 0;
}

function completedEvent(
  before: Task,
  after: Task,
): TaskEventInput | null {
  if (before.done || !after.done) return null;
  const late =
    after.dueAt !== null &&
    after.completedAt !== null &&
    Date.parse(after.completedAt) > Date.parse(after.dueAt);
  return {
    taskId: after.id,
    userId: after.userId,
    actorUserId: after.userId,
    type: 'task.completed',
    payload: {
      completedAt: after.completedAt,
      dueAt: after.dueAt,
      late,
    },
  };
}

function reopenedEvent(before: Task, after: Task): TaskEventInput | null {
  if (!before.done || after.done) return null;
  return {
    taskId: after.id,
    userId: after.userId,
    actorUserId: after.userId,
    type: 'task.reopened',
    payload: { completedAt: before.completedAt, reopenedAt: after.updatedAt },
  };
}

function updateEvents(before: Task, after: Task): TaskEventInput[] {
  const events: TaskEventInput[] = [];
  const base = {
    taskId: after.id,
    userId: after.userId,
    actorUserId: after.userId,
  };
  if (before.text !== after.text) {
    events.push({ ...base, type: 'task.text_changed', payload: { before: before.text, after: after.text } });
  }
  if (before.dueAt !== after.dueAt) {
    events.push({ ...base, type: 'task.due_changed', payload: { before: before.dueAt, after: after.dueAt, shiftCount: 1 } });
  }
  if (before.priority !== after.priority) {
    events.push({ ...base, type: 'task.priority_changed', payload: { before: before.priority, after: after.priority } });
  }
  if (before.category !== after.category) {
    events.push({ ...base, type: 'task.category_changed', payload: { before: before.category, after: after.category } });
  }
  if (before.assigneeEmail !== after.assigneeEmail) {
    events.push({ ...base, type: 'task.assignee_changed', payload: { before: before.assigneeEmail, after: after.assigneeEmail } });
  }
  if (before.progress !== after.progress) {
    events.push({ ...base, type: 'task.progress_changed', payload: { before: before.progress, after: after.progress } });
  }
  const completed = completedEvent(before, after);
  if (completed) events.push(completed);
  const reopened = reopenedEvent(before, after);
  if (reopened) events.push(reopened);
  if (events.length === 0) {
    events.push({ ...base, type: 'task.updated', payload: {} });
  }
  return events;
}

export async function updateTask(
  db: Db,
  userId: string,
  id: string,
  teamIds: string[],
  patch: TaskPatch,
): Promise<Task | null> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<TaskRow>(
      `select ${TASK_COLUMNS} from tasks where id = $1 for update`,
      [id],
    );
    const row = rows[0];
    if (!row || !canAccess(row, userId, teamIds)) return null;

    const milestones = await loadMilestones(tx, [id]);
    const before = toTask(row, milestones.get(id) ?? []);
    const now = new Date().toISOString();

    const done =
      patch.progress !== undefined && patch.done === undefined
        ? patch.progress >= 100
        : patch.done !== undefined
          ? patch.done
          : before.done;
    const progress =
      patch.done !== undefined && patch.progress === undefined
        ? patch.done
          ? 100
          : 0
        : clamp(patch.progress ?? before.progress);
    const completedAt = !done
      ? null
      : !before.done || !before.completedAt
        ? now
        : before.completedAt;

    const updated = await tx.query<TaskRow>(
      `update tasks
          set text = $2,
              done = $3,
              progress = $4,
              priority = $5,
              category = $6,
              due_at = $7::timestamptz,
              scheduled_start_at = $8::timestamptz,
              reminder_at = $9::timestamptz,
              assignee_email = $10,
              completed_at = $11::timestamptz,
              updated_at = $12::timestamptz,
              version = version + 1
        where id = $1
        returning ${TASK_COLUMNS}`,
      [
        id,
        patch.text ?? before.text,
        done,
        progress,
        patch.priority !== undefined ? patch.priority : before.priority,
        patch.category !== undefined ? patch.category : before.category,
        patch.dueAt !== undefined ? patch.dueAt : before.dueAt,
        patch.scheduledStartAt !== undefined
          ? patch.scheduledStartAt
          : before.scheduledStartAt,
        patch.reminderAt !== undefined ? patch.reminderAt : before.reminderAt,
        patch.assigneeEmail !== undefined
          ? patch.assigneeEmail
          : before.assigneeEmail,
        completedAt,
        now,
      ],
    );
    const after = toTask(updated[0], before.milestones);
    for (const event of updateEvents(before, after)) {
      await insertTaskEvent(tx, { ...event, occurredAt: now });
    }
    return after;
  });
}

export async function addMilestones(
  db: Db,
  userId: string,
  id: string,
  teamIds: string[],
  entries: Array<{ text: string; progress: number }>,
): Promise<Task | null> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<TaskRow>(
      `select ${TASK_COLUMNS} from tasks where id = $1 for update`,
      [id],
    );
    const row = rows[0];
    if (!row || !canAccess(row, userId, teamIds)) return null;

    const existing = await loadMilestones(tx, [id]);
    const before = toTask(row, existing.get(id) ?? []);
    const now = new Date().toISOString();
    const milestones: Milestone[] = entries.map((entry) => ({
      id: randomUUID(),
      text: entry.text,
      progress: clamp(entry.progress),
      createdAt: now,
    }));
    for (const milestone of milestones) {
      await tx.query(
        `insert into task_milestones (id, task_id, user_id, text, progress, created_at)
         values ($1, $2, $3, $4, $5, $6::timestamptz)`,
        [
          milestone.id,
          id,
          row.user_id,
          milestone.text,
          milestone.progress,
          milestone.createdAt,
        ],
      );
      await insertTaskEvent(tx, {
        taskId: id,
        userId: row.user_id,
        actorUserId: userId,
        type: 'task.milestone_added',
        payload: { milestoneId: milestone.id, progress: milestone.progress },
        occurredAt: now,
      });
    }

    const value = clamp(
      Math.max(before.progress, ...milestones.map((entry) => entry.progress)),
    );
    const done = value >= 100;
    const completedAt = !done
      ? null
      : !before.done || !before.completedAt
        ? now
        : before.completedAt;

    const updated = await tx.query<TaskRow>(
      `update tasks
          set progress = $2,
              done = $3,
              completed_at = $4::timestamptz,
              updated_at = $5::timestamptz,
              version = version + 1
        where id = $1
        returning ${TASK_COLUMNS}`,
      [id, value, done, completedAt, now],
    );
    const after = toTask(updated[0], [...before.milestones, ...milestones]);
    for (const event of updateEvents(before, after)) {
      if (event.type === 'task.progress_changed' || event.type === 'task.completed') {
        await insertTaskEvent(tx, { ...event, occurredAt: now });
      }
    }
    return after;
  });
}

export async function removeTask(
  db: Db,
  userId: string,
  id: string,
  teamIds: string[],
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<TaskRow>(
      `select ${TASK_COLUMNS} from tasks where id = $1 and deleted_at is null for update`,
      [id],
    );
    const row = rows[0];
    if (!row || !canAccess(row, userId, teamIds)) return false;

    const now = new Date().toISOString();
    await tx.query(
      `update tasks
          set deleted_at = $2::timestamptz, updated_at = $2::timestamptz, version = version + 1
        where id = $1`,
      [id, now],
    );
    await insertTaskEvent(tx, {
      taskId: id,
      userId: row.user_id,
      actorUserId: userId,
      type: 'task.deleted',
      payload: { dueAt: toNullableIso(row.due_at), done: row.done },
      occurredAt: now,
    });
    return true;
  });
}

export async function clearCompletedTasks(
  db: Db,
  userId: string,
  teamId?: string | null,
): Promise<Task[]> {
  return db.transaction(async (tx) => {
    const scope = scopeSql(userId, teamId);
    const rows = await tx.query<TaskRow>(
      `select ${TASK_COLUMNS} from tasks
        where done = true and ${scope.sql}
        for update`,
      scope.params,
    );
    const now = new Date().toISOString();
    for (const row of rows) {
      await tx.query(
        `update tasks
            set deleted_at = $2::timestamptz, updated_at = $2::timestamptz, version = version + 1
          where id = $1`,
        [row.id, now],
      );
      await insertTaskEvent(tx, {
        taskId: row.id,
        userId: row.user_id,
        actorUserId: userId,
        type: 'task.deleted',
        payload: { dueAt: toNullableIso(row.due_at), done: true },
        occurredAt: now,
      });
    }
    const remaining = await tx.query<TaskRow>(
      `select ${TASK_COLUMNS} from tasks
        where ${scope.sql}
        order by sort_order asc, created_at desc`,
      scope.params,
    );
    return mapRows(tx, remaining);
  });
}

export async function reorderTasks(
  db: Db,
  userId: string,
  ids: string[],
  teamId?: string | null,
): Promise<Task[]> {
  return db.transaction(async (tx) => {
    const scope = scopeSql(userId, teamId);
    const rows = await tx.query<TaskRow>(
      `select ${TASK_COLUMNS} from tasks
        where ${scope.sql}
        order by sort_order asc, created_at desc
        for update`,
      scope.params,
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const seen = new Set<string>();
    const ordered: TaskRow[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (row && !seen.has(id)) {
        seen.add(id);
        ordered.push(row);
      }
    }
    for (const row of rows) {
      if (!seen.has(row.id)) ordered.push(row);
    }

    const now = new Date().toISOString();
    for (let index = 0; index < ordered.length; index += 1) {
      const row = ordered[index];
      const previousOrder = Number(row.sort_order);
      if (previousOrder === index) continue;
      await tx.query(
        'update tasks set sort_order = $2, updated_at = $3::timestamptz where id = $1',
        [row.id, index, now],
      );
      await insertTaskEvent(tx, {
        taskId: row.id,
        userId: row.user_id,
        actorUserId: userId,
        type: 'task.reordered',
        payload: { before: previousOrder, after: index },
        occurredAt: now,
      });
    }

    const updated = await tx.query<TaskRow>(
      `select ${TASK_COLUMNS} from tasks
        where ${scope.sql}
        order by sort_order asc, created_at desc`,
      scope.params,
    );
    return mapRows(tx, updated);
  });
}

export async function claimUnownedTasks(
  db: Db,
  userId: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<TaskRow>(
      `update tasks
          set user_id = $1, updated_at = now(), version = version + 1
        where user_id is null
        returning ${TASK_COLUMNS}`,
      [userId],
    );
    for (const row of rows) {
      await insertTaskEvent(tx, {
        taskId: row.id,
        userId,
        actorUserId: userId,
        type: 'task.claimed',
        payload: {},
      });
    }
    return rows.length;
  });
}

export async function deletePersonalTasksForUser(
  db: Db,
  userId: string,
): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `delete from tasks
      where user_id = $1 and team_id is null
      returning id`,
    [userId],
  );
  return rows.length;
}
