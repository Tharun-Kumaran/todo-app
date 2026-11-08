export interface Milestone {
  id: string;
  text: string;
  /** Completion percentage recorded when this update was posted (0-100). */
  progress: number;
  createdAt: string;
}

export interface Task {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp of when the task was completed, or null while pending. */
  completedAt: string | null;
  /** ISO timestamp of the deadline, or null when none is set. */
  dueAt: string | null;
  /** Current completion percentage (0-100). */
  progress: number;
  /** Timestamped progress updates, oldest first. */
  milestones: Milestone[];
}

export interface TasksResponse {
  tasks: Task[];
}

export interface TaskResponse {
  task: Task;
}

export type Filter = 'all' | 'pending' | 'overdue' | 'completed';
