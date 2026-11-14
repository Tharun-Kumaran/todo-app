export type Priority = 'Low' | 'Medium' | 'High' | 'Urgent';

export type TaskCategory =
  | 'Software Engineering'
  | 'Product Design'
  | 'DevOps & Infrastructure'
  | 'Data Engineering & AI'
  | 'Quality Assurance'
  | 'Finance & Compliance'
  | 'Operations'
  | 'Marketing & Content';

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
  /** Task priority (Low, Medium, High, Urgent). */
  priority?: Priority | null;
  /** Task category / department. */
  category?: TaskCategory | null;
  /** Optional planned work window chosen from a Time Machine recommendation. */
  scheduledStartAt?: string | null;
  /** Optional in-app reminder time chosen from a Time Machine recommendation. */
  reminderAt?: string | null;
  /** Optimistic-concurrency version, incremented on every mutation. */
  version: number;
  /** Current completion percentage (0-100). */
  progress: number;
  /** Timestamped progress updates, oldest first. */
  milestones: Milestone[];
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type Confidence = 'low' | 'medium' | 'high';
export type RecommendationType =
  | 'deadline_change'
  | 'schedule_window'
  | 'split_subtasks'
  | 'reminder'
  | 'recurrence_series';

export interface PredictionEvidence {
  taskId: string;
  text: string;
  similarity: number;
  outcome: 'on_time' | 'late' | 'overdue';
  durationDays: number | null;
}

export interface TimeMachineBaseline {
  /** Probability of completing by the deadline, or within 7 days when no deadline exists. */
  completionProbability: number;
  /** 80% interval for the probability. */
  interval: [number, number];
  deadline: string | null;
  expectedCompletion: { p50: string; p80: string } | null;
  riskLevel: RiskLevel;
  confidence: Confidence;
  sampleSize: number;
  mode: 'personal' | 'blended' | 'global';
  reasons: string[];
  evidence: PredictionEvidence[];
}

export interface TimeMachineRecommendation {
  id: string;
  type: RecommendationType;
  label: string;
  payload: {
    dueAt?: string;
    scheduledStartAt?: string;
    milestones?: string[];
    reminderAt?: string;
    rrule?: string;
    title?: string;
  };
  baselineProbability: number;
  recommendedProbability: number;
  lift: number;
  confidence: Confidence;
  /** False when the action is structural and there is not enough data for a numeric lift. */
  estimated: boolean;
  reasons: string[];
}

export interface TimeMachineResponse {
  taskId: string;
  generatedAt: string;
  model: {
    version: string;
    mode: 'personal' | 'blended' | 'global';
    sampleSize: number;
    confidence: Confidence;
  };
  baseline: TimeMachineBaseline;
  recommendations: TimeMachineRecommendation[];
  holdout: boolean;
}

export type RecommendationStatus =
  | 'active'
  | 'accepted'
  | 'dismissed'
  | 'expired'
  | 'superseded';

export interface RecurringSeries {
  id: string;
  userId: string;
  title: string;
  rrule: string;
  timezone: string;
  autoCreate: boolean;
  status: 'suggested' | 'active' | 'paused' | 'ended';
  nextAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecommendationApplyResponse {
  task: Task;
  timeMachine: TimeMachineResponse;
  recommendation: TimeMachineRecommendation;
  series?: RecurringSeries;
}

export interface TimeMachineInsights {
  resolved: number;
  brier: number | null;
  baselineBrier: number | null;
  calibrationError: number | null;
  coldStart: boolean;
  recommendations: {
    shown: number;
    accepted: number;
    dismissed: number;
    acceptanceRate: number | null;
  };
  patterns: Array<{ label: string; detail: string; sampleSize: number }>;
}

export interface RecommendationOption {
  id: string;
  type: 'set_deadline' | 'change_priority' | 'split_task';
  label: string;
  value?: string;
}

export interface PredictionRequest {
  text: string;
  dueAt?: string | null;
  priority?: Priority;
  category?: TaskCategory;
  teamId?: string | null;
  teamTask?: boolean;
}

export interface PredictionResponse {
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  delayProbability: number;
  predictedDurationDays: number;
  suggestedLeadDays: number;
  suggestedDueAt: string;
  reasons: string[];
  recommendations: RecommendationOption[];
  benchmark: {
    category: TaskCategory;
    priority: Priority;
    actionVerb: string;
    medianDays: number;
    p85Days: number;
  };
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
