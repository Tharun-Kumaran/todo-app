import { useEffect, useState, type FormEvent } from 'react';
import type { SessionInfo } from '../../shared/types';
import * as api from '../api';

interface Props {
  onClose: () => void;
  onSignedOut: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function formatWhen(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function shortAgent(value: string | null): string {
  if (!value) return 'Unknown browser';
  if (/edg\//i.test(value)) return 'Microsoft Edge';
  if (/chrome\//i.test(value)) return 'Chrome';
  if (/firefox\//i.test(value)) return 'Firefox';
  if (/safari\//i.test(value)) return 'Safari';
  return value.slice(0, 80);
}

export function SecurityPanel({ onClose, onSignedOut }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let active = true;
    void api
      .fetchSessions()
      .then((next) => {
        if (active) setSessions(next);
      })
      .catch((err) => {
        if (active) setError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, []);

  async function revoke(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.revokeSession(id);
      setSessions((current) =>
        current ? current.filter((session) => session.id !== id) : current,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function revokeOthers() {
    setRevokingOthers(true);
    setError(null);
    try {
      await api.revokeOtherSessions();
      setSessions((current) =>
        current ? current.filter((session) => session.current) : current,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRevokingOthers(false);
    }
  }

  async function downloadExport() {
    setExporting(true);
    setError(null);
    try {
      const data = await api.exportAccount();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `todo-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  async function removeAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmDelete || !password || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteAccount(password);
      onSignedOut();
    } catch (err) {
      setError(errorMessage(err));
      setDeleting(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="security-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="security-title"
      >
        <header className="security-head">
          <div>
            <h2 id="security-title">Account security</h2>
            <p>Manage signed-in devices and your data.</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close security panel"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        {error && (
          <div className="banner auth-error" role="alert">
            <p>{error}</p>
          </div>
        )}

        <section className="security-section">
          <div className="security-section-head">
            <h3>Signed-in devices</h3>
            <button
              type="button"
              className="ghost-btn"
              disabled={revokingOthers || !sessions || sessions.length < 2}
              onClick={() => void revokeOthers()}
            >
              {revokingOthers ? 'Signing out…' : 'Sign out other devices'}
            </button>
          </div>

          {sessions === null ? (
            <div className="loading security-loading">
              <span className="spinner" aria-hidden="true" />
              Loading sessions…
            </div>
          ) : (
            <ul className="session-list">
              {sessions.map((session) => (
                <li key={session.id} className="session-item">
                  <div className="session-copy">
                    <strong>
                      {shortAgent(session.userAgent)}
                      {session.current && (
                        <span className="session-current">This device</span>
                      )}
                    </strong>
                    <span>
                      Signed in {formatWhen(session.createdAt)} · last active{' '}
                      {formatWhen(session.lastSeenAt)}
                    </span>
                    <span>Expires {formatWhen(session.expiresAt)}</span>
                  </div>
                  {!session.current && (
                    <button
                      type="button"
                      className="ghost-btn danger-text"
                      disabled={busyId !== null}
                      onClick={() => void revoke(session.id)}
                    >
                      {busyId === session.id ? 'Revoking…' : 'Revoke'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="security-section">
          <div className="security-section-head">
            <h3>Your data</h3>
            <button
              type="button"
              className="ghost-btn"
              disabled={exporting}
              onClick={() => void downloadExport()}
            >
              {exporting ? 'Preparing…' : 'Export as JSON'}
            </button>
          </div>
          <p className="security-note">
            Export includes your profile, tasks, teams, and Time Machine
            history.
          </p>
        </section>

        <section className="security-section security-danger">
          <div className="security-section-head">
            <h3>Delete account</h3>
          </div>
          <p className="security-note">
            This permanently removes your personal tasks, Time Machine history,
            and sessions. Teams you own must be deleted or transferred first.
          </p>
          <form
            className="security-delete-form"
            onSubmit={(event) => void removeAccount(event)}
          >
            <label className="auth-field">
              <span>Confirm with your password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Your password"
              />
            </label>
            <label className="security-check">
              <input
                type="checkbox"
                checked={confirmDelete}
                onChange={(event) => setConfirmDelete(event.target.checked)}
              />
              <span>I understand this cannot be undone.</span>
            </label>
            <button
              type="submit"
              className="danger-btn"
              disabled={deleting || !confirmDelete || !password}
            >
              {deleting ? 'Deleting…' : 'Delete my account'}
            </button>
          </form>
        </section>
      </section>
    </div>
  );
}
