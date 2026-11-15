import { useEffect, useState } from 'react';
import type { TimeMachineInsights } from '../../shared/types';
import * as api from '../api';

interface Props {
  onClose: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function score(value: number | null): string {
  return value === null ? '—' : value.toFixed(3);
}

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

export function InsightsPanel({ onClose }: Props) {
  const [insights, setInsights] = useState<TimeMachineInsights | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .fetchTimeMachineInsights()
      .then((next) => {
        if (active) setInsights(next);
      })
      .catch((err) => {
        if (active) setError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, []);

  const betterThanBaseline =
    insights?.brier !== null &&
    insights?.baselineBrier !== null &&
    insights !== null &&
    insights.brier < insights.baselineBrier;

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="security-panel insights-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="insights-title"
      >
        <header className="security-head">
          <div>
            <h2 id="insights-title">Time Machine insights</h2>
            <p>How your forecasts and recommendations are performing.</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close insights"
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

        {insights === null && !error ? (
          <div className="loading security-loading">
            <span className="spinner" aria-hidden="true" />
            Loading insights…
          </div>
        ) : (
          insights && (
            <>
              {insights.coldStart && (
                <p className="security-note insights-cold-start">
                  Early estimate: {insights.resolved} resolved prediction
                  {insights.resolved === 1 ? '' : 's'} so far. Insights become
                  more meaningful after about 20 outcomes.
                </p>
              )}

              <section className="security-section">
                <div className="security-section-head">
                  <h3>Forecast accuracy</h3>
                  <span className="settings-badge is-verified">
                    {insights.resolved} resolved
                  </span>
                </div>
                <div className="insights-grid">
                  <div>
                    <span>Brier score</span>
                    <strong>{score(insights.brier)}</strong>
                    <small>Lower is better.</small>
                  </div>
                  <div>
                    <span>Baseline</span>
                    <strong>{score(insights.baselineBrier)}</strong>
                    <small>A fixed 55% guess.</small>
                  </div>
                  <div>
                    <span>Calibration error</span>
                    <strong>{score(insights.calibrationError)}</strong>
                    <small>How close predicted odds are to outcomes.</small>
                  </div>
                </div>
                <p className="security-note">
                  {insights.resolved < 1
                    ? 'Complete a few tasks with deadlines to start scoring forecasts.'
                    : betterThanBaseline
                      ? 'Your calibrated forecast is currently beating the fixed baseline.'
                      : 'The calibrated forecast has not beaten the fixed baseline yet.'}
                </p>
              </section>

              <section className="security-section">
                <div className="security-section-head">
                  <h3>Recommendations</h3>
                  <span className="settings-badge">
                    {percent(insights.recommendations.acceptanceRate)} accepted
                  </span>
                </div>
                <div className="insights-grid">
                  <div>
                    <span>Shown</span>
                    <strong>{insights.recommendations.shown}</strong>
                  </div>
                  <div>
                    <span>Accepted</span>
                    <strong>{insights.recommendations.accepted}</strong>
                  </div>
                  <div>
                    <span>Dismissed</span>
                    <strong>{insights.recommendations.dismissed}</strong>
                  </div>
                </div>
                <p className="security-note">
                  Acceptance is not proof of lift. The randomized holdout is what
                  makes the comparison causal.
                </p>
              </section>

              <section className="security-section">
                <div className="security-section-head">
                  <h3>Patterns</h3>
                </div>
                {insights.patterns.length === 0 ? (
                  <p className="security-note">
                    No patterns yet. Complete more personal tasks to unlock
                    weekday, duration, and recurring-task insights.
                  </p>
                ) : (
                  <ul className="insights-patterns">
                    {insights.patterns.map((pattern) => (
                      <li key={`${pattern.label}-${pattern.detail}`}>
                        <div>
                          <strong>{pattern.label}</strong>
                          <span>{pattern.detail}</span>
                        </div>
                        <small>
                          n={pattern.sampleSize}
                        </small>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )
        )}
      </section>
    </div>
  );
}
