import { randomUUID } from 'node:crypto';
import type { Priority, Task, TaskCategory } from '../shared/types';
import { getDb } from './db/client.ts';
import {
  addMilestones,
  claimUnownedTasks,
  clearCompletedTasks,
  countTasksForUser,
  createTask,
  deletePersonalTasksForUser,
  getTaskForUser,
  listTasksForUser,
  removeTask,
  reorderTasks,
  updateTask,
  type TaskPatch,
} from './repositories/tasks.ts';

export type { TaskPatch };

/**
 * Task persistence backed by Postgres/PGlite. Every mutation writes the task
 * row and its `task_events` rows in one transaction. Reads are always scoped
 * to the owner or to verified team membership.
 */
export class TaskStore {
  /** Kept for constructor compatibility; the database is the store now. */
  constructor(_file?: string) {}

  async init(): Promise<void> {
    // The database is opened and migrated by the server bootstrap.
  }

  async listFor(userId: string, teamId?: string | null): Promise<Task[]> {
    return listTasksForUser(await getDb(), userId, teamId);
  }

  async countFor(userId: string, teamId?: string | null): Promise<number> {
    return countTasksForUser(await getDb(), userId, teamId);
  }

  async get(
    userId: string,
    id: string,
    userTeamIds: string[] = [],
  ): Promise<Task | null> {
    return getTaskForUser(await getDb(), userId, id, userTeamIds);
  }

  async add(
    userId: string,
    creatorEmail: string,
    text: string,
    dueAt: string | null,
    teamId?: string | null,
    assigneeEmail?: string | null,
    priority?: Priority | null,
    category?: TaskCategory | null,
    scheduledStartAt?: string | null,
    reminderAt?: string | null,
  ): Promise<Task> {
    const now = new Date().toISOString();
    return createTask(await getDb(), {
      id: randomUUID(),
      userId,
      creatorEmail,
      teamId: teamId || null,
      assigneeEmail: assigneeEmail || null,
      priority: priority || 'Medium',
      category: category || null,
      text,
      done: false,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      dueAt,
      scheduledStartAt: scheduledStartAt || null,
      reminderAt: reminderAt || null,
      version: 1,
      progress: 0,
      milestones: [],
    });
  }

  async update(
    userId: string,
    id: string,
    userTeamIds: string[],
    patch: TaskPatch,
  ): Promise<Task | null> {
    return updateTask(await getDb(), userId, id, userTeamIds, patch);
  }

  async addMilestone(
    userId: string,
    id: string,
    userTeamIds: string[],
    text: string,
    progress?: number,
  ): Promise<Task | null> {
    const task = await this.get(userId, id, userTeamIds);
    if (!task) return null;
    return addMilestones(await getDb(), userId, id, userTeamIds, [
      { text, progress: progress ?? task.progress },
    ]);
  }

  /**
   * Add several checkpoints in one atomic write. Used when a user applies a
   * "split into checkpoints" Time Machine recommendation.
   */
  async addMilestones(
    userId: string,
    id: string,
    userTeamIds: string[],
    entries: Array<{ text: string; progress: number }>,
  ): Promise<Task | null> {
    return addMilestones(await getDb(), userId, id, userTeamIds, entries);
  }

  async remove(
    userId: string,
    id: string,
    userTeamIds: string[],
  ): Promise<boolean> {
    return removeTask(await getDb(), userId, id, userTeamIds);
  }

  async clearCompleted(
    userId: string,
    teamId?: string | null,
  ): Promise<Task[]> {
    return clearCompletedTasks(await getDb(), userId, teamId);
  }

  async reorder(
    userId: string,
    ids: string[],
    teamId?: string | null,
  ): Promise<Task[]> {
    return reorderTasks(await getDb(), userId, ids, teamId);
  }

  /** Give tasks created before accounts existed to the first registered user. */
  async claimUnowned(userId: string): Promise<number> {
    return claimUnownedTasks(await getDb(), userId);
  }

  /** Remove a user's personal tasks when they delete their account. */
  async removePersonalForUser(userId: string): Promise<number> {
    return deletePersonalTasksForUser(await getDb(), userId);
  }
}
