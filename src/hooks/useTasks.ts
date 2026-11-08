import { useCallback, useEffect, useState } from 'react';
import type { Task } from '../../shared/types';
import * as api from '../api';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setTasks(await api.fetchTasks());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addTask = useCallback(
    async (text: string, dueAt: string | null): Promise<boolean> => {
      try {
        const task = await api.createTask(text, dueAt);
        setTasks((current) => [task, ...current]);
        setError(null);
        return true;
      } catch (err) {
        setError(errorMessage(err));
        return false;
      }
    },
    [],
  );

  const toggleTask = useCallback(async (task: Task): Promise<boolean> => {
    const nextDone = !task.done;
    const optimistic: Task = {
      ...task,
      done: nextDone,
      progress: nextDone ? 100 : 0,
    };
    setTasks((current) =>
      current.map((item) => (item.id === task.id ? optimistic : item)),
    );
    try {
      const updated = await api.updateTask(task.id, {
        done: nextDone,
        progress: nextDone ? 100 : 0,
      });
      setTasks((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setError(null);
      return true;
    } catch (err) {
      setTasks((current) =>
        current.map((item) => (item.id === task.id ? task : item)),
      );
      setError(errorMessage(err));
      return false;
    }
  }, []);

  const editTask = useCallback(
    async (id: string, text: string): Promise<boolean> => {
      try {
        const updated = await api.updateTask(id, { text });
        setTasks((current) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
        );
        setError(null);
        return true;
      } catch (err) {
        setError(errorMessage(err));
        return false;
      }
    },
    [],
  );

  const setProgress = useCallback(
    async (task: Task, progress: number): Promise<boolean> => {
      const value = Math.min(100, Math.max(0, Math.round(progress)));
      const optimistic: Task = { ...task, progress: value, done: value >= 100 };
      setTasks((current) =>
        current.map((item) => (item.id === task.id ? optimistic : item)),
      );
      try {
        const updated = await api.updateTask(task.id, { progress: value });
        setTasks((current) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
        );
        setError(null);
        return true;
      } catch (err) {
        setTasks((current) =>
          current.map((item) => (item.id === task.id ? task : item)),
        );
        setError(errorMessage(err));
        return false;
      }
    },
    [],
  );

  const setDue = useCallback(
    async (task: Task, dueAt: string | null): Promise<boolean> => {
      const optimistic: Task = { ...task, dueAt };
      setTasks((current) =>
        current.map((item) => (item.id === task.id ? optimistic : item)),
      );
      try {
        const updated = await api.updateTask(task.id, { dueAt });
        setTasks((current) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
        );
        setError(null);
        return true;
      } catch (err) {
        setTasks((current) =>
          current.map((item) => (item.id === task.id ? task : item)),
        );
        setError(errorMessage(err));
        return false;
      }
    },
    [],
  );

  const addMilestone = useCallback(
    async (task: Task, text: string, progress: number): Promise<boolean> => {
      try {
        const updated = await api.addMilestone(task.id, text, progress);
        setTasks((current) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
        );
        setError(null);
        return true;
      } catch (err) {
        setError(errorMessage(err));
        return false;
      }
    },
    [],
  );

  const removeTask = useCallback(async (id: string): Promise<boolean> => {
    try {
      await api.deleteTask(id);
      setTasks((current) => current.filter((item) => item.id !== id));
      setError(null);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  }, []);

  const clearDone = useCallback(async (): Promise<boolean> => {
    try {
      setTasks(await api.clearCompleted());
      setError(null);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  }, []);

  const reorder = useCallback(
    async (ordered: Task[]): Promise<boolean> => {
      setTasks(ordered);
      try {
        setTasks(await api.reorderTasks(ordered.map((task) => task.id)));
        setError(null);
        return true;
      } catch (err) {
        setError(errorMessage(err));
        await refresh();
        return false;
      }
    },
    [refresh],
  );

  const dismissError = useCallback(() => setError(null), []);

  return {
    tasks,
    loading,
    error,
    refresh,
    addTask,
    toggleTask,
    editTask,
    setProgress,
    setDue,
    addMilestone,
    removeTask,
    clearDone,
    reorder,
    dismissError,
  };
}
