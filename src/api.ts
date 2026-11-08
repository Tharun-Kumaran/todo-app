import type { Task } from '../shared/types';

const base = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    throw new Error(
      'Could not reach the task server. Start it with "npm run dev" (API on port 3001).',
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
    throw new Error(message);
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
  progress?: number;
}

export function fetchTasks(): Promise<Task[]> {
  return request<{ tasks: Task[] }>('/api/tasks').then((data) => data.tasks);
}

export function createTask(text: string, dueAt: string | null = null): Promise<Task> {
  return request<{ task: Task }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ text, dueAt }),
  }).then((data) => data.task);
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
  progress: number,
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

export function clearCompleted(): Promise<Task[]> {
  return request<{ tasks: Task[] }>('/api/tasks/clear-completed', {
    method: 'POST',
  }).then((data) => data.tasks);
}

export function reorderTasks(ids: string[]): Promise<Task[]> {
  return request<{ tasks: Task[] }>('/api/tasks/order', {
    method: 'PUT',
    body: JSON.stringify({ ids }),
  }).then((data) => data.tasks);
}
