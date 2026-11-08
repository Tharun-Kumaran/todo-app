import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Milestone, Task } from '../shared/types';

interface TaskFile {
  version: 3;
  tasks: StoredTask[];
}

/**
 * Stored tasks may predate accounts (`userId: null`). The first account to
 * register claims them; after that every task belongs to a user or a team.
 */
type StoredTask = Omit<Task, 'userId'> & { userId: string | null };

export interface TaskPatch {
  text?: string;
  done?: boolean;
  dueAt?: string | null;
  progress?: number;
  assigneeEmail?: string | null;
}

/**
 * In-memory task list with an atomic, serialized JSON file store.
 * Every mutation writes the whole file through a temp file + rename,
 * so a crash can't leave a half-written tasks.json behind.
 *
 * All reads and writes are scoped to a user id or team membership,
 * so one account can never see or change another account's personal tasks.
 */
export class TaskStore {
  private tasks: StoredTask[] = [];
  private opChain: Promise<unknown> = Promise.resolve();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<TaskFile>;
      this.tasks = Array.isArray(parsed.tasks)
        ? parsed.tasks
            .map(normalizeTask)
            .filter((task): task is StoredTask => task !== null)
        : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.error(`Could not read ${this.file}; starting with an empty list.`, error);
        try {
          await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          // Nothing else we can do; the next write will recreate the file.
        }
      }
      this.tasks = [];
      await this.persist([]);
    }
  }

  private canAccess(task: StoredTask, userId: string, userTeamIds: string[]): boolean {
    if (task.teamId) {
      return userTeamIds.includes(task.teamId);
    }
    return task.userId === userId;
  }

  listFor(userId: string, teamId?: string | null): Task[] {
    if (teamId) {
      return this.tasks
        .filter((task) => task.teamId === teamId)
        .map(toTask);
    }
    return this.tasks
      .filter((task) => task.userId === userId && (!task.teamId || task.teamId === null))
      .map(toTask);
  }

  countFor(userId: string, teamId?: string | null): number {
    if (teamId) {
      return this.tasks.filter((task) => task.teamId === teamId).length;
    }
    return this.tasks.filter(
      (task) => task.userId === userId && (!task.teamId || task.teamId === null),
    ).length;
  }

  get(userId: string, id: string, userTeamIds: string[] = []): Task | null {
    const task = this.tasks.find(
      (item) => item.id === id && this.canAccess(item, userId, userTeamIds),
    );
    return task ? toTask(task) : null;
  }

  add(
    userId: string,
    creatorEmail: string,
    text: string,
    dueAt: string | null,
    teamId?: string | null,
    assigneeEmail?: string | null,
  ): Promise<Task> {
    const now = new Date().toISOString();
    const task: StoredTask = {
      id: randomUUID(),
      userId,
      creatorEmail,
      teamId: teamId || null,
      assigneeEmail: assigneeEmail || null,
      text,
      done: false,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      dueAt,
      progress: 0,
      milestones: [],
    };
    return this.mutate((tasks) => ({
      next: [task, ...tasks],
      result: toTask(task),
    }));
  }

  update(
    userId: string,
    id: string,
    userTeamIds: string[],
    patch: TaskPatch,
  ): Promise<Task | null> {
    return this.mutate((tasks) => {
      const index = tasks.findIndex(
        (task) => task.id === id && this.canAccess(task, userId, userTeamIds),
      );
      if (index === -1) return { next: tasks, result: null };

      const current = tasks[index];
      const now = new Date().toISOString();
      const updated: StoredTask = {
        ...current,
        ...patch,
        updatedAt: now,
      };

      // Keep `done` and `progress` coherent no matter which one was sent.
      if (patch.progress !== undefined && patch.done === undefined) {
        updated.done = patch.progress >= 100;
      } else if (patch.done !== undefined && patch.progress === undefined) {
        updated.progress = patch.done ? 100 : 0;
      }
      updated.progress = clamp(updated.progress);

      // Stamp the transition into/out of the completed state.
      if (!updated.done) {
        updated.completedAt = null;
      } else if (!current.done || !current.completedAt) {
        updated.completedAt = now;
      }

      const next = [...tasks];
      next[index] = updated;
      return { next, result: toTask(updated) };
    });
  }

  addMilestone(
    userId: string,
    id: string,
    userTeamIds: string[],
    text: string,
    progress?: number,
  ): Promise<Task | null> {
    return this.mutate((tasks) => {
      const index = tasks.findIndex(
        (task) => task.id === id && this.canAccess(task, userId, userTeamIds),
      );
      if (index === -1) return { next: tasks, result: null };

      const current = tasks[index];
      const value = clamp(progress ?? current.progress);
      const now = new Date().toISOString();
      const milestone: Milestone = {
        id: randomUUID(),
        text,
        progress: value,
        createdAt: now,
      };

      const updated: StoredTask = {
        ...current,
        progress: value,
        done: value >= 100,
        completedAt: value >= 100 ? (current.completedAt ?? now) : null,
        milestones: [...current.milestones, milestone],
        updatedAt: now,
      };

      const next = [...tasks];
      next[index] = updated;
      return { next, result: toTask(updated) };
    });
  }

  remove(userId: string, id: string, userTeamIds: string[]): Promise<boolean> {
    return this.mutate((tasks) => {
      const next = tasks.filter(
        (task) => !(task.id === id && this.canAccess(task, userId, userTeamIds)),
      );
      return { next, result: next.length !== tasks.length };
    });
  }

  clearCompleted(userId: string, teamId?: string | null): Promise<Task[]> {
    return this.mutate((tasks) => {
      const next = tasks.filter((task) => {
        if (!task.done) return true;
        if (teamId) {
          return task.teamId !== teamId;
        }
        return !(task.userId === userId && (!task.teamId || task.teamId === null));
      });
      return {
        next,
        result: teamId
          ? next.filter((task) => task.teamId === teamId).map(toTask)
          : next
              .filter(
                (task) => task.userId === userId && (!task.teamId || task.teamId === null),
              )
              .map(toTask),
      };
    });
  }

  reorder(userId: string, ids: string[], teamId?: string | null): Promise<Task[]> {
    return this.mutate((tasks) => {
      const scoped = teamId
        ? tasks.filter((task) => task.teamId === teamId)
        : tasks.filter(
            (task) => task.userId === userId && (!task.teamId || task.teamId === null),
          );

      const byId = new Map(scoped.map((task) => [task.id, task]));
      const seen = new Set<string>();
      const ordered: StoredTask[] = [];

      for (const id of ids) {
        const task = byId.get(id);
        if (task && !seen.has(id)) {
          seen.add(id);
          ordered.push(task);
        }
      }
      for (const task of scoped) {
        if (!seen.has(task.id)) ordered.push(task);
      }

      let cursor = 0;
      const isTarget = (task: StoredTask) =>
        teamId
          ? task.teamId === teamId
          : task.userId === userId && (!task.teamId || task.teamId === null);

      const next = tasks.map((task) =>
        isTarget(task) ? ordered[cursor++] ?? task : task,
      );

      return {
        next,
        result: teamId
          ? next.filter((task) => task.teamId === teamId).map(toTask)
          : next
              .filter(
                (task) => task.userId === userId && (!task.teamId || task.teamId === null),
              )
              .map(toTask),
      };
    });
  }

  /** Give tasks created before accounts existed to the first registered user. */
  async claimUnowned(userId: string): Promise<number> {
    if (!this.tasks.some((task) => task.userId === null)) return 0;
    return this.mutate((tasks) => {
      let claimed = 0;
      const next = tasks.map((task) => {
        if (task.userId !== null) return task;
        claimed += 1;
        return { ...task, userId };
      });
      return { next, result: claimed };
    });
  }

  private mutate<T>(
    fn: (tasks: StoredTask[]) => { next: StoredTask[]; result: T },
  ): Promise<T> {
    const run = this.opChain.then(async () => {
      const { next, result } = fn(this.tasks.map(cloneStoredTask));
      await this.persist(next);
      this.tasks = next;
      return result;
    });
    this.opChain = run.catch(() => {});
    return run;
  }

  private async persist(tasks: StoredTask[]): Promise<void> {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true });
    const temp = `${this.file}.tmp-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const payload: TaskFile = { version: 3, tasks };
    await fs.writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(temp, this.file);
  }
}

function clamp(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function cloneStoredTask(task: StoredTask): StoredTask {
  return {
    ...task,
    milestones: task.milestones.map((entry) => ({ ...entry })),
  };
}

function toTask(task: StoredTask): Task {
  if (task.userId === null) {
    throw new Error('Refusing to return a task that has no owner.');
  }
  return {
    ...task,
    userId: task.userId,
    creatorEmail: task.creatorEmail ?? null,
    teamId: task.teamId ?? null,
    assigneeEmail: task.assigneeEmail ?? null,
    milestones: task.milestones.map((entry) => ({ ...entry })),
  };
}

/**
 * Accepts tasks written by any version of the store and fills in fields
 * added later with safe defaults.
 */
function normalizeTask(value: unknown): StoredTask | null {
  if (!value || typeof value !== 'object') return null;
  const task = value as Record<string, unknown>;

  if (
    typeof task.id !== 'string' ||
    typeof task.text !== 'string' ||
    typeof task.done !== 'boolean' ||
    typeof task.createdAt !== 'string' ||
    typeof task.updatedAt !== 'string'
  ) {
    return null;
  }

  const progress =
    typeof task.progress === 'number' && Number.isFinite(task.progress)
      ? clamp(task.progress)
      : task.done
        ? 100
        : 0;

  return {
    id: task.id,
    userId:
      typeof task.userId === 'string' && task.userId.length > 0
        ? task.userId
        : null,
    creatorEmail:
      typeof task.creatorEmail === 'string' && task.creatorEmail.length > 0
        ? task.creatorEmail
        : null,
    teamId:
      typeof task.teamId === 'string' && task.teamId.length > 0
        ? task.teamId
        : null,
    assigneeEmail:
      typeof task.assigneeEmail === 'string' && task.assigneeEmail.length > 0
        ? task.assigneeEmail
        : null,
    text: task.text,
    done: task.done,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt:
      typeof task.completedAt === 'string' &&
      !Number.isNaN(Date.parse(task.completedAt))
        ? task.completedAt
        : task.done
          ? task.updatedAt
          : null,
    dueAt:
      typeof task.dueAt === 'string' && !Number.isNaN(Date.parse(task.dueAt))
        ? task.dueAt
        : null,
    progress,
    milestones: Array.isArray(task.milestones)
      ? task.milestones
          .map(normalizeMilestone)
          .filter((entry): entry is Milestone => entry !== null)
      : [],
  };
}

function normalizeMilestone(value: unknown): Milestone | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== 'string' ||
    typeof entry.text !== 'string' ||
    typeof entry.createdAt !== 'string'
  ) {
    return null;
  }
  return {
    id: entry.id,
    text: entry.text,
    progress:
      typeof entry.progress === 'number' && Number.isFinite(entry.progress)
        ? clamp(entry.progress)
        : 0,
    createdAt: entry.createdAt,
  };
}
