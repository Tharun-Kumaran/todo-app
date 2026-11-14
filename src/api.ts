import type {
  PredictionRequest,
  PredictionResponse,
  Priority,
  RecommendationApplyResponse,
  RecurringSeries,
  SessionInfo,
  Task,
  TaskCategory,
  Team,
  TimeMachineInsights,
  TimeMachineResponse,
  User,
} from '../shared/types';

const base = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    throw new ApiError(
      'Could not reach the task server. Start it with "npm run dev" (API on port 3001).',
      0,
    );
  }

  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const data = (await response.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // Keep the generic message when the body is not JSON.
    }

    // Expired or revoked sessions drop the UI back to the sign-in screen.
    if (
      response.status === 401 &&
      !path.startsWith('/api/auth/') &&
      path !== '/api/account' &&
      typeof window !== 'undefined'
    ) {
      window.dispatchEvent(new Event('todo:unauthorized'));
    }

    throw new ApiError(message, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

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

export interface PredictionPreview {
  prediction: PredictionResponse;
  timeMachine: TimeMachineResponse | null;
}

// --- Authentication -------------------------------------------------------

export function fetchMe(): Promise<User | null> {
  return request<{ user: User }>('/api/auth/me')
    .then((data) => data.user)
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    });
}

export function register(
  email: string,
  password: string,
  inviteCode?: string,
): Promise<User> {
  return request<{ user: User }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, inviteCode }),
  }).then((data) => data.user);
}

export function login(email: string, password: string): Promise<User> {
  return request<{ user: User }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  }).then((data) => data.user);
}

export function logout(): Promise<void> {
  return request<void>('/api/auth/logout', { method: 'POST' });
}

export function fetchSessions(): Promise<SessionInfo[]> {
  return request<{ sessions: SessionInfo[] }>('/api/auth/sessions').then(
    (data) => data.sessions,
  );
}

export function revokeSession(id: string): Promise<void> {
  return request<void>(`/api/auth/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function revokeOtherSessions(): Promise<number> {
  return request<{ revoked: number }>('/api/auth/sessions/revoke-others', {
    method: 'POST',
  }).then((data) => data.revoked);
}

export function exportAccount(): Promise<unknown> {
  return request<unknown>('/api/account/export');
}

export function deleteAccount(password: string): Promise<void> {
  return request<void>('/api/account', {
    method: 'DELETE',
    body: JSON.stringify({ password }),
  });
}

// --- Teams ----------------------------------------------------------------

export function fetchTeams(): Promise<Team[]> {
  return request<{ teams: Team[] }>('/api/teams').then((data) => data.teams);
}

export function createTeam(name: string): Promise<Team> {
  return request<{ team: Team }>('/api/teams', {
    method: 'POST',
    body: JSON.stringify({ name }),
  }).then((data) => data.team);
}

export function fetchTeam(id: string): Promise<Team> {
  return request<{ team: Team }>(`/api/teams/${encodeURIComponent(id)}`).then(
    (data) => data.team,
  );
}

export function addTeamMember(teamId: string, email: string): Promise<Team> {
  return request<{ team: Team }>(
    `/api/teams/${encodeURIComponent(teamId)}/members`,
    {
      method: 'POST',
      body: JSON.stringify({ email }),
    },
  ).then((data) => data.team);
}

export function removeTeamMember(
  teamId: string,
  email: string,
): Promise<Team> {
  return request<{ team: Team }>(
    `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(email)}`,
    {
      method: 'DELETE',
    },
  ).then((data) => data.team);
}

// --- Tasks ----------------------------------------------------------------

export function fetchTasks(teamId?: string | null): Promise<Task[]> {
  const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
  return request<{ tasks: Task[] }>(`/api/tasks${query}`).then(
    (data) => data.tasks,
  );
}

export function createTask(
  text: string,
  dueAt: string | null = null,
  teamId?: string | null,
  assigneeEmail?: string | null,
  priority?: Priority | null,
  category?: TaskCategory | null,
  scheduledStartAt?: string | null,
  reminderAt?: string | null,
): Promise<Task> {
  return request<{ task: Task }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      text,
      dueAt,
      teamId: teamId || null,
      assigneeEmail: assigneeEmail || null,
      priority: priority || 'Medium',
      category: category || null,
      scheduledStartAt: scheduledStartAt || null,
      reminderAt: reminderAt || null,
    }),
  }).then((data) => data.task);
}

export function predictTask(data: PredictionRequest): Promise<PredictionPreview> {
  return request<PredictionPreview>('/api/tasks/predict', {
    method: 'POST',
    body: JSON.stringify(data),
  }).then((response) => ({
    prediction: response.prediction,
    timeMachine: response.timeMachine ?? null,
  }));
}

export function updateTask(id: string, patch: TaskPatch): Promise<Task> {
  return request<{ task: Task }>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }).then((data) => data.task);
}

export function addMilestone(
  id: string,
  text: string,
  progress?: number,
): Promise<Task> {
  return request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(id)}/milestones`,
    {
      method: 'POST',
      body: JSON.stringify({ text, progress }),
    },
  ).then((data) => data.task);
}

export function deleteTask(id: string): Promise<void> {
  return request<void>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function clearCompleted(teamId?: string | null): Promise<Task[]> {
  const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
  return request<{ tasks: Task[] }>(`/api/tasks/clear-completed${query}`, {
    method: 'POST',
  }).then((data) => data.tasks);
}

export function reorderTasks(
  ids: string[],
  teamId?: string | null,
): Promise<Task[]> {
  const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
  return request<{ tasks: Task[] }>(`/api/tasks/order${query}`, {
    method: 'PUT',
    body: JSON.stringify({ ids }),
  }).then((data) => data.tasks);
}

// --- Time Machine ---------------------------------------------------------

export function fetchTimeMachine(taskId: string): Promise<TimeMachineResponse> {
  return request<{ timeMachine: TimeMachineResponse }>(
    `/api/tasks/${encodeURIComponent(taskId)}/time-machine`,
  ).then((data) => data.timeMachine);
}

export function applyRecommendation(
  id: string,
  expectedVersion: number,
): Promise<RecommendationApplyResponse> {
  return request<RecommendationApplyResponse>(
    `/api/recommendations/${encodeURIComponent(id)}/apply`,
    {
      method: 'POST',
      body: JSON.stringify({ expectedVersion }),
    },
  );
}

export function dismissRecommendation(
  id: string,
  reason?: 'not_useful' | 'too_busy' | 'wrong' | 'other',
): Promise<void> {
  return request<void>(
    `/api/recommendations/${encodeURIComponent(id)}/dismiss`,
    {
      method: 'POST',
      body: JSON.stringify({ reason }),
    },
  );
}

export function recordRecommendationImpressions(ids: string[]): Promise<void> {
  if (ids.length === 0) return Promise.resolve();
  return request<void>('/api/recommendations/impressions', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

export function fetchTimeMachineInsights(): Promise<TimeMachineInsights> {
  return request<{ insights: TimeMachineInsights }>(
    '/api/time-machine/insights',
  ).then((data) => data.insights);
}

export function fetchSeries(): Promise<RecurringSeries[]> {
  return request<{ series: RecurringSeries[] }>('/api/series').then(
    (data) => data.series,
  );
}
