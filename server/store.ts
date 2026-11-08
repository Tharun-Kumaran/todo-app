import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Task } from '../shared/types';

interface TaskFile {
  version: 1;
  tasks: Task[];
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
      this.tasks = Array.isArray(parsed.tasks) ? parsed.tasks.filter(isTask) : [];
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
    return this.tasks.map((task) => ({ ...task }));
  }

  add(text: string): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      text,
      done: false,
      createdAt: now,
      updatedAt: now,
    };
    return this.mutate((tasks) => ({ next: [task, ...tasks], result: task }));
  }

  update(id: string, patch: { text?: string; done?: boolean }): Promise<Task | null> {
    return this.mutate((tasks) => {
      const index = tasks.findIndex((task) => task.id === id);
      if (index === -1) return { next: tasks, result: null };

      const updated: Task = {
        ...tasks[index],
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      const next = [...tasks];
      next[index] = updated;
      return { next, result: updated };
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
      return { next, result: next };
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
      return { next: ordered, result: ordered };
    });
  }

  private mutate<T>(
    fn: (tasks: Task[]) => { next: Task[]; result: T },
  ): Promise<T> {
    const run = this.opChain.then(async () => {
      const { next, result } = fn(this.tasks.map((task) => ({ ...task })));
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
    const body: TaskFile = { version: 1, tasks };
    await fs.writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    await fs.rename(temp, this.file);
  }
}

function isTask(value: unknown): value is Task {
  if (!value || typeof value !== 'object') return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === 'string' &&
    typeof task.text === 'string' &&
    typeof task.done === 'boolean' &&
    typeof task.createdAt === 'string' &&
    typeof task.updatedAt === 'string'
  );
}
