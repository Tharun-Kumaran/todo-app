export interface Milestone {
  id: string;
  text: string;
  /** Completion percentage recorded when this update was posted (0-100). */
  progress: number;
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

export interface TeamMember {
  userId?: string | null;
  email: string;
  role: 'owner' | 'member';
  joinedAt: string;
}

export interface Team {
  id: string;
  name: string;
  ownerId: string;
  ownerEmail: string;
  members: TeamMember[];
  createdAt: string;
}

export interface Task {
  id: string;
  /** User ID of the creator. */
  userId: string;
  /** Email of the creator for display in team views. */
  creatorEmail?: string | null;
  /** ID of the team this task belongs to, or null/undefined if personal. */
  teamId?: string | null;
  /** Optional email of the team member assigned to this task. */
  assigneeEmail?: string | null;
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

export interface AuthResponse {
  user: User;
}

export interface TeamResponse {
  team: Team;
}

export interface TeamsResponse {
  teams: Team[];
}

export type Filter = 'all' | 'pending' | 'overdue' | 'completed';
