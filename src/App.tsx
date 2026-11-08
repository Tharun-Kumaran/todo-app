import { useEffect, useMemo, useState } from 'react';
import type { Filter, Task } from '../shared/types';
import { useTasks } from './hooks/useTasks';
import { Header } from './components/Header';
import { TaskForm } from './components/TaskForm';
import { TaskItem } from './components/TaskItem';
import { EmptyState } from './components/EmptyState';
import { Filters } from './components/Filters';
import { ProgressBar } from './components/ProgressBar';

export default function App() {
  const {
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
  } = useTasks();

  const [filter, setFilter] = useState<Filter>('all');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // Re-evaluate overdue tasks while the app stays open.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const { visible, total, done, pending, overdue } = useMemo(() => {
    const doneCount = tasks.filter((task) => task.done).length;
    const overdueCount = tasks.filter((task) => isOverdue(task, now)).length;
    const visibleTasks =
      filter === 'pending'
        ? tasks.filter((task) => !task.done)
        : filter === 'overdue'
          ? tasks.filter((task) => isOverdue(task, now))
          : filter === 'completed'
            ? tasks.filter((task) => task.done)
            : tasks;
    return {
      visible: visibleTasks,
      total: tasks.length,
      done: doneCount,
      pending: tasks.length - doneCount,
      overdue: overdueCount,
    };
  }, [tasks, filter, now]);

  const canReorder = filter === 'all' && !loading && visible.length > 1;
  const percent = total
    ? Math.round(
        tasks.reduce(
          (sum, task) => sum + (task.done ? 100 : task.progress),
          0,
        ) / total,
      )
    : 0;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      if (event.key === '/' && !typing) {
        event.preventDefault();
        document.getElementById('new-task')?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  function resetDrag() {
    setDraggingId(null);
    setDragOverId(null);
  }

  function handleDrop(targetId: string) {
    if (!draggingId || draggingId === targetId) {
      resetDrag();
      return;
    }

    const from = tasks.findIndex((task) => task.id === draggingId);
    const to = tasks.findIndex((task) => task.id === targetId);
    if (from === -1 || to === -1) {
      resetDrag();
      return;
    }

    const next = [...tasks];
    const [moved] = next.splice(from, 1);
    if (!moved) {
      resetDrag();
      return;
    }
    next.splice(to, 0, moved);
    resetDrag();
    void reorder(next);
  }

  return (
    <main className="app">
      <Header />
      <ProgressBar percent={percent} />

      {error && (
        <div className="banner" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => void refresh()}>
            Retry
          </button>
          <button type="button" onClick={dismissError}>
            Dismiss
          </button>
        </div>
      )}

      <TaskForm onAdd={addTask} />

      {loading ? (
        <div className="loading">
          <span className="spinner" aria-hidden="true" />
          Loading tasks…
        </div>
      ) : visible.length === 0 ? (
        <EmptyState filter={filter} total={total} />
      ) : (
        <ul className="tasks" aria-label="Tasks">
          {visible.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              draggable={canReorder}
              dragging={draggingId === task.id}
              dragOver={dragOverId === task.id && draggingId !== task.id}
              onToggle={() => void toggleTask(task)}
              onEdit={(text) => editTask(task.id, text)}
              onProgress={(progress) => setProgress(task, progress)}
              onDue={(dueAt) => setDue(task, dueAt)}
              onMilestone={(text, progress) => addMilestone(task, text, progress)}
              onDelete={() => void removeTask(task.id)}
              onDragStart={() => setDraggingId(task.id)}
              onDragOver={() => setDragOverId(task.id)}
              onDrop={() => handleDrop(task.id)}
              onDragEnd={resetDrag}
            />
          ))}
        </ul>
      )}

      <footer className="footer">
        <span className="count" aria-live="polite">
          {countLabel(total, pending, overdue)}
        </span>
        <Filters
          value={filter}
          onChange={setFilter}
          total={total}
          pending={pending}
          overdue={overdue}
          done={done}
        />
        <button
          className="clear"
          type="button"
          onClick={() => void clearDone()}
          disabled={done === 0}
        >
          Clear done
        </button>
      </footer>
    </main>
  );
}

function isOverdue(task: Task, now: number): boolean {
  return (
    !task.done &&
    task.dueAt !== null &&
    new Date(task.dueAt).getTime() < now
  );
}

function countLabel(total: number, pending: number, overdue: number): string {
  if (total === 0) return 'No tasks';
  if (pending === 0) return 'All done 🎉';
  const base = `${pending} task${pending === 1 ? '' : 's'} left`;
  return overdue > 0 ? `${base} · ${overdue} overdue` : base;
}
