export interface Task {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TasksResponse {
  tasks: Task[];
}

export interface TaskResponse {
  task: Task;
}

export type Filter = 'all' | 'active' | 'completed';
