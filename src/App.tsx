import { useEffect, useMemo, useState } from 'react';
import type { Filter, Task, User } from '../shared/types';
import * as api from './api';
import { useAuth } from './hooks/useAuth';
import { useTasks } from './hooks/useTasks';
import { useTeams } from './hooks/useTeams';
import { AccountActionScreen, type AccountAction } from './components/AccountActionScreen';
import { AuthScreen } from './components/AuthScreen';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { TeamHeader } from './components/TeamHeader';
import { TaskForm } from './components/TaskForm';
import { TaskItem } from './components/TaskItem';
import { EmptyState } from './components/EmptyState';
import { Filters } from './components/Filters';
import { ProgressBar } from './components/ProgressBar';
import { SecurityPanel } from './components/SecurityPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { SeriesPanel } from './components/SeriesPanel';
import { InsightsPanel } from './components/InsightsPanel';

function readAccountAction(): AccountAction | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const verify = params.get('verify');
  if (verify) return { kind: 'verify', token: verify };
  const reset = params.get('reset');
  if (reset) return { kind: 'reset', token: reset };
  return null;
}

function clearAccountActionFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete('verify');
  url.searchParams.delete('reset');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

export default function App() {
  const {
    user,
    loading: authLoading,
    error: authError,
    signIn,
    signUp,
    signOut,
    refreshUser,
  } = useAuth();
  const [accountAction, setAccountAction] = useState<AccountAction | null>(() =>
    readAccountAction(),
  );

  if (accountAction) {
    return (
      <AccountActionScreen
        action={accountAction}
        onFinish={() => {
          clearAccountActionFromUrl();
          setAccountAction(null);
          void refreshUser().catch(() => undefined);
        }}
      />
    );
  }

  if (authLoading) {
    return (
      <main className="app">
        <div className="loading" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          Checking your session…
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <AuthScreen
        initialError={authError}
        onSignIn={signIn}
        onSignUp={signUp}
        onRequestReset={api.requestPasswordReset}
      />
    );
  }

  return (
    <TodoApp
      key={user.id}
      user={user}
      onSignOut={() => void signOut()}
      onRefreshUser={refreshUser}
    />
  );
}

interface TodoAppProps {
  user: User;
  onSignOut: () => void;
  onRefreshUser: () => Promise<User | null>;
}

function TodoApp({ user, onSignOut, onRefreshUser }: TodoAppProps) {
  const { teams, createNewTeam, inviteMember, removeMember } = useTeams();
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [seriesOpen, setSeriesOpen] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);

  const selectedTeam = useMemo(
    () => (activeTeamId ? teams.find((t) => t.id === activeTeamId) ?? null : null),
    [teams, activeTeamId],
  );

  const {
    tasks,
    loading,
    error,
    refresh,
    replaceTask,
    addTask,
    toggleTask,
    editTask,
    setAssignee,
    setProgress,
    setDue,
    addMilestone,
    removeTask,
    clearDone,
    reorder,
    dismissError,
  } = useTasks(activeTeamId);

  const [filter, setFilter] = useState<Filter>('all');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
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
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement;
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
    <div className="workspace-layout">
      <Sidebar
        user={user}
        teams={teams}
        activeTeamId={activeTeamId}
        personalPendingCount={activeTeamId === null ? pending : 0}
        isOpen={sidebarOpen}
        onSelectPersonal={() => setActiveTeamId(null)}
        onSelectTeam={(teamId) => setActiveTeamId(teamId)}
        onCreateTeam={createNewTeam}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="app main-workspace">
        <Header
          user={user}
          onSignOut={onSignOut}
          onOpenSecurity={() => setSecurityOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenInsights={() => setInsightsOpen(true)}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
        />

        {selectedTeam ? (
          <TeamHeader
            team={selectedTeam}
            currentUser={user}
            onInviteMember={(email) => inviteMember(selectedTeam.id, email)}
            onRemoveMember={(email) => removeMember(selectedTeam.id, email)}
          />
        ) : (
          <div className="personal-header-banner">
            <div className="banner-text">
              <h2>👤 My Personal Tasks</h2>
              <p>Private to you. Teammates cannot see personal tasks.</p>
            </div>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setSeriesOpen(true)}
            >
              Recurring series
            </button>
          </div>
        )}

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

        <TaskForm
          onAdd={addTask}
          teamMembers={selectedTeam ? selectedTeam.members : undefined}
        />

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
                teamMembers={selectedTeam ? selectedTeam.members : undefined}
                onToggle={() => void toggleTask(task)}
                onEdit={(text) => editTask(task.id, text)}
                onAssignee={(email) => setAssignee(task, email)}
                onProgress={(progress) => setProgress(task, progress)}
                onDue={(dueAt) => setDue(task, dueAt)}
                onMilestone={(text, progress) =>
                  addMilestone(task, text, progress)
                }
                onTaskReplaced={replaceTask}
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

      {securityOpen && (
        <SecurityPanel
          onClose={() => setSecurityOpen(false)}
          onSignedOut={onSignOut}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          user={user}
          onClose={() => setSettingsOpen(false)}
          onUserUpdated={() => {
            void onRefreshUser().catch(() => undefined);
          }}
        />
      )}

      {seriesOpen && (
        <SeriesPanel
          onClose={() => setSeriesOpen(false)}
          onTasksChanged={() => void refresh()}
        />
      )}

      {insightsOpen && (
        <InsightsPanel onClose={() => setInsightsOpen(false)} />
      )}
    </div>
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
