import { useEffect, useState } from 'react';
import type { RecurringSeries } from '../../shared/types';
import { describeRrule } from '../../shared/recurrence';
import * as api from '../api';

interface Props {
  onClose: () => void;
  onTasksChanged: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function formatWhen(value: string | null): string {
  if (!value) return 'No upcoming occurrence';
  return new Date(value).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function confidenceLabel(series: RecurringSeries): string {
  const parts: string[] = [];
  if (typeof series.sampleCount === 'number' && series.sampleCount > 0) {
    parts.push(`${series.sampleCount} completions`);
  }
  if (typeof series.detectionConfidence === 'number') {
    parts.push(`${Math.round(series.detectionConfidence * 100)}% confident`);
  }
  return parts.join(' · ');
}

export function SeriesPanel({ onClose, onTasksChanged }: Props) {
  const [series, setSeries] = useState<RecurringSeries[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [materializing, setMaterializing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .fetchSeries()
      .then((next) => {
        if (active) setSeries(next);
      })
      .catch((err) => {
        if (active) setError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, []);

  function replaceSeries(updated: RecurringSeries) {
    setSeries((current) =>
      current
        ? current.map((entry) => (entry.id === updated.id ? updated : entry))
        : current,
    );
  }

  async function patch(
    target: RecurringSeries,
    changes: { autoCreate?: boolean; status?: RecurringSeries['status'] },
  ) {
    setBusyId(target.id);
    setError(null);
    setNotice(null);
    try {
      replaceSeries(await api.updateSeries(target.id, changes));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function skip(target: RecurringSeries) {
    setBusyId(target.id);
    setError(null);
    setNotice(null);
    try {
      replaceSeries(await api.skipSeries(target.id));
      setNotice(`Skipped the next "${target.title}" occurrence.`);
      onTasksChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function end(target: RecurringSeries) {
    if (
      !window.confirm(
        `End "${target.title}"? This stops scheduling permanently.`,
      )
    ) {
      return;
    }
    setBusyId(target.id);
    setError(null);
    setNotice(null);
    try {
      replaceSeries(await api.updateSeries(target.id, { status: 'ended' }));
      setNotice(`Ended "${target.title}". No new occurrences will be created.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function materialize() {
    setMaterializing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.materializeSeries();
      setSeries(result.series);
      setNotice(
        result.tasks.some((task) => task.seriesId)
          ? 'Recurring series are up to date.'
          : 'No recurring tasks are due yet.',
      );
      onTasksChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setMaterializing(false);
    }
  }

  const suggested = series?.filter((entry) => entry.status === 'suggested') ?? [];
  const tracked = series?.filter((entry) => entry.status !== 'suggested') ?? [];

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="security-panel series-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="series-title"
      >
        <header className="security-head">
          <div>
            <h2 id="series-title">Recurring series</h2>
            <p>Patterns are suggested first. Auto-create is always your choice.</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close recurring series"
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
        {notice && <p className="security-note series-notice">{notice}</p>}

        <section className="security-section">
          <div className="security-section-head">
            <h3>Detected patterns</h3>
          </div>
          {series === null ? (
            <div className="loading security-loading">
              <span className="spinner" aria-hidden="true" />
              Looking for patterns…
            </div>
          ) : suggested.length === 0 ? (
            <p className="security-note">
              Complete the same personal task at least three times on a regular
              cadence and it will appear here as a suggestion.
            </p>
          ) : (
            <ul className="series-list">
              {suggested.map((entry) => (
                <li key={entry.id} className="series-item">
                  <div className="series-copy">
                    <strong>{entry.title}</strong>
                    <span>
                      {describeRrule(entry.rrule)}
                      {confidenceLabel(entry) ? ` · ${confidenceLabel(entry)}` : ''}
                    </span>
                    <span>Next {formatWhen(entry.nextAt)}</span>
                  </div>
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={busyId !== null}
                    onClick={() =>
                      void patch(entry, { status: 'active', autoCreate: false })
                    }
                  >
                    {busyId === entry.id ? 'Activating…' : 'Activate series'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="security-section">
          <div className="security-section-head">
            <h3>Your series</h3>
            <button
              type="button"
              className="ghost-btn"
              disabled={materializing}
              onClick={() => void materialize()}
            >
              {materializing ? 'Checking…' : 'Check for due tasks'}
            </button>
          </div>

          {series !== null && tracked.length === 0 ? (
            <p className="security-note">
              No active recurring series yet. Activate a detected pattern above,
              or accept a recurrence recommendation on a task.
            </p>
          ) : (
            <ul className="series-list">
              {tracked.map((entry) => (
                <li key={entry.id} className="series-item">
                  <div className="series-copy">
                    <strong>
                      {entry.title}
                      <span className={`series-status is-${entry.status}`}>
                        {entry.status}
                      </span>
                    </strong>
                    <span>
                      {describeRrule(entry.rrule)} · {entry.timezone}
                    </span>
                    <span>Next {formatWhen(entry.nextAt)}</span>
                  </div>
                  <div className="series-controls">
                    <label className="series-check">
                      <input
                        type="checkbox"
                        checked={entry.autoCreate}
                        disabled={busyId === entry.id || entry.status === 'ended'}
                        onChange={(event) =>
                          void patch(entry, {
                            autoCreate: event.target.checked,
                          })
                        }
                      />
                      <span>Auto-create</span>
                    </label>
                    <button
                      type="button"
                      className="ghost-btn"
                      disabled={busyId === entry.id || entry.status === 'ended'}
                      onClick={() => void skip(entry)}
                    >
                      Skip next
                    </button>
                    {entry.status !== 'ended' && (
                      <button
                        type="button"
                        className="ghost-btn"
                        disabled={busyId === entry.id}
                        onClick={() =>
                          void patch(entry, {
                            status:
                              entry.status === 'active' ? 'paused' : 'active',
                          })
                        }
                      >
                        {entry.status === 'active' ? 'Pause' : 'Resume'}
                      </button>
                    )}
                    {entry.status !== 'ended' && (
                      <button
                        type="button"
                        className="ghost-btn"
                        disabled={busyId === entry.id}
                        onClick={() => void end(entry)}
                      >
                        End
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </section>
    </div>
  );
}
