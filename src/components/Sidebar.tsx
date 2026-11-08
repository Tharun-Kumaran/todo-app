import { useState, type FormEvent } from 'react';
import type { Team, User } from '../../shared/types';
import { PlusIcon } from './icons';

interface Props {
  user: User;
  teams: Team[];
  activeTeamId: string | null;
  personalPendingCount: number;
  isOpen: boolean;
  onSelectPersonal: () => void;
  onSelectTeam: (teamId: string) => void;
  onCreateTeam: (name: string) => Promise<Team | null>;
  onClose: () => void;
}

export function Sidebar({
  user,
  teams,
  activeTeamId,
  personalPendingCount,
  isOpen,
  onSelectPersonal,
  onSelectTeam,
  onCreateTeam,
  onClose,
}: Props) {
  const [showCreate, setShowCreate] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const name = teamName.trim();
    if (!name || busy) return;
    setBusy(true);
    const created = await onCreateTeam(name);
    setBusy(false);
    if (created) {
      setTeamName('');
      setShowCreate(false);
      onSelectTeam(created.id);
    }
  }

  return (
    <>
      {isOpen && (
        <div
          className="sidebar-backdrop"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside className={`app-sidebar${isOpen ? ' open' : ''}`}>
        <div className="sidebar-brand">
          <div className="brand-icon">✓</div>
          <div className="brand-text">
            <h2>To-Do Workspace</h2>
            <span className="user-email-chip" title={user.email}>
              {user.email}
            </span>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-section">
            <span className="section-title">Personal</span>
            <button
              type="button"
              className={`nav-item${activeTeamId === null ? ' active' : ''}`}
              onClick={() => {
                onSelectPersonal();
                onClose();
              }}
            >
              <span className="nav-icon">👤</span>
              <span className="nav-label">My Tasks</span>
              {personalPendingCount > 0 && (
                <span className="nav-badge">{personalPendingCount}</span>
              )}
            </button>
          </div>

          <div className="sidebar-section">
            <div className="section-header-row">
              <span className="section-title">Teams</span>
              <button
                type="button"
                className="section-add-btn"
                title="Create a new team"
                onClick={() => setShowCreate((v) => !v)}
              >
                <PlusIcon />
                <span>New</span>
              </button>
            </div>

            {showCreate && (
              <form
                className="create-team-form"
                onSubmit={(e) => void handleCreate(e)}
              >
                <input
                  type="text"
                  className="create-team-input"
                  placeholder="Team or project name…"
                  value={teamName}
                  maxLength={60}
                  autoFocus
                  onChange={(e) => setTeamName(e.target.value)}
                />
                <div className="create-team-actions">
                  <button
                    type="submit"
                    className="create-team-btn"
                    disabled={busy || !teamName.trim()}
                  >
                    {busy ? 'Creating…' : 'Create'}
                  </button>
                  <button
                    type="button"
                    className="cancel-btn"
                    onClick={() => setShowCreate(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            <div className="team-list">
              {teams.length === 0 && !showCreate && (
                <div className="sidebar-empty">
                  <p>No teams yet.</p>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => setShowCreate(true)}
                  >
                    + Create your first team
                  </button>
                </div>
              )}

              {teams.map((team) => {
                const isActive = activeTeamId === team.id;
                const isHost =
                  team.ownerId === user.id ||
                  team.ownerEmail.toLowerCase() === user.email.toLowerCase();

                return (
                  <button
                    key={team.id}
                    type="button"
                    className={`nav-item team-item${isActive ? ' active' : ''}`}
                    onClick={() => {
                      onSelectTeam(team.id);
                      onClose();
                    }}
                  >
                    <span className="team-avatar">
                      {team.name.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="nav-label" title={team.name}>
                      {team.name}
                    </span>
                    <span className="team-meta">
                      {isHost && <span className="host-pill">Host</span>}
                      <span className="members-count" title={`${team.members.length} members`}>
                        👥 {team.members.length}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </nav>
      </aside>
    </>
  );
}
