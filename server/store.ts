import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Milestone, Task } from '../shared/types';

interface TaskFile {
  version: 2;
  tasks: Task[];
}

export interface TaskPatch {
  text?: string;
  done?: boolean;
  dueAt?: string | null;
  progress?: number;
}

/**
 * In-memory task list with an atomic, serialized JSON file store.
 * Every mutation writes the whole file through a temp file + rename,
 * so a crash can't leave a half-written tasks.json behind.
 */
export class TaskStore {
  private tasks: Task[] = [];
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
            .filter((task): task is Task => task !== null)
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

  list(): Task[] {
    return this.tasks.map(cloneTask);
  }

  get(id: string): Task | null {
    const task = this.tasks.find((item) => item.id === id);
    return task ? cloneTask(task) : null;
  }

  add(text: string, dueAt: string | null): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      text,
      done: false,
      createdAt: now,
      updatedAt: now,
      dueAt,
      progress: 0,
      milestones: [],
    };
    return this.mutate((tasks) => ({ next: [task, ...tasks], result: cloneTask(task) }));
  }

  update(id: string, patch: TaskPatch): Promise<Task | null> {
    return this.mutate((tasks) => {
      const index = tasks.findIndex((task) => task.id === id);
      if (index === -1) return { next: tasks, result: null };

      const current = tasks[index];
      const updated: Task = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      };

      // Keep `done` and `progress` coherent no matter which one was sent.
      if (patch.progress !== undefined && patch.done === undefined) {
        updated.done = patch.progress >= 100;
      } else if (patch.done !== undefined && patch.progress === undefined) {
        updated.progress = patch.done ? 100 : 0;
      }
      updated.progress = clamp(updated.progress);

      const next = [...tasks];
      next[index] = updated;
      return { next, result: cloneTask(updated) };
    });
  }

  addMilestone(
    id: string,
    text: string,
    progress?: number,
  ): Promise<Task | null> {
    return this.mutate((tasks) => {
      const index = tasks.findIndex((task) => task.id === id);
      if (index === -1) return { next: tasks, result: null };

      const current = tasks[index];
      const value = clamp(progress ?? current.progress);
      const milestone: Milestone = {
        id: randomUUID(),
        text,
        progress: value,
        createdAt: new Date().toISOString(),
      };

      const updated: Task = {
        ...current,
        progress: value,
        done: value >= 100,
        milestones: [...current.milestones, milestone],
        updatedAt: new Date().toISOString(),
      };

      const next = [...tasks];
      next[index] = updated;
      return { next, result: cloneTask(updated) };
    });
  }

  remove(id: string): Promise<boolean> {
    return this.mutate((tasks) => {
      const next = tasks.filter((task) => task.id !== id);
      return { next, result: next.length !== tasks.length };
    });
  }

  clearCompleted(): Promise<Task[]> {
    return this.mutate((tasks) => {
      const next = tasks.filter((task) => !task.done);
      return { next, result: next.map(cloneTask) };
    });
  }

  reorder(ids: string[]): Promise<Task[]> {
    return this.mutate((tasks) => {
      const byId = new Map(tasks.map((task) => [task.id, task]));
      const ordered = ids
        .map((id) => byId.get(id))
        .filter((task): task is Task => Boolean(task));
      for (const task of tasks) {
        if (!ids.includes(task.id)) ordered.push(task);
      }
      return { next: ordered, result: ordered.map(cloneTask) };
    });
  }

  private mutate<T>(
    fn: (tasks: Task[]) => { next: Task[]; result: T },
  ): Promise<T> {
    const run = this.opChain.then(async () => {
      const { next, result } = fn(this.tasks.map(cloneTask));
      await this.persist(next);
      this.tasks = next;
      return result;
    });
    this.opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async persist(tasks: Task[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    const body: TaskFile = { version: 2, tasks };
    await fs.writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    await fs.rename(temp, this.file);
  }
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function cloneTask(task: Task): Task {
  return { ...task, milestones: task.milestones.map((entry) => ({ ...entry })) };
}

/**
 * Accepts tasks written by any version of the store and fills in fields
 * added later (deadlines, progress, milestones) with safe defaults.
 */
function normalizeTask(value: unknown): Task | null {
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
    text: task.text,
    done: task.done,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
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
