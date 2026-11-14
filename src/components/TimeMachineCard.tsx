import { useState } from 'react';
import type {
  TimeMachineRecommendation,
  TimeMachineResponse,
} from '../../shared/types';

interface Props {
  timeMachine: TimeMachineResponse | null;
  loading?: boolean;
  error?: string | null;
  compact?: boolean;
  teamTask?: boolean;
  onApply?: (recommendation: TimeMachineRecommendation) => Promise<boolean>;
  onDismiss?: (recommendation: TimeMachineRecommendation) => Promise<void>;
  onRetry?: () => void;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function liftLabel(value: number): string {
  const points = Math.round(value * 100);
  return `${points >= 0 ? '+' : ''}${points} points`;
}

function formatDate(value: string | null): string {
  if (!value) return 'No deadline';
  return new Date(value).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function confidenceLabel(value: 'low' | 'medium' | 'high'): string {
  return value === 'high'
    ? 'High confidence'
    : value === 'medium'
      ? 'Medium confidence'
      : 'Early estimate';
}

function outcomeLabel(value: 'on_time' | 'late' | 'overdue'): string {
  return value === 'on_time'
    ? 'on time'
    : value === 'late'
      ? 'late'
      : 'overdue';
}

export function TimeMachineCard({
  timeMachine,
  loading = false,
  error = null,
  compact = false,
  teamTask = false,
  onApply,
  onDismiss,
  onRetry,
}: Props) {
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (loading && !timeMachine) {
    return (
      <div className="time-machine-card tm-loading" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <span>Time Machine is checking your history…</span>
      </div>
    );
  }

  if (error && !timeMachine) {
    return (
      <div className="time-machine-card tm-error" role="alert">
        <p>The Time Machine is unavailable right now. Your task is saved.</p>
        {onRetry && (
          <button type="button" className="ghost-btn" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  }

  if (!timeMachine) return null;

  const baseline = timeMachine.baseline;
  const primary = timeMachine.recommendations[0] ?? null;
  const alternatives = timeMachine.recommendations.slice(1);
  const learningGap = Math.max(0, 5 - baseline.sampleSize);

  async function apply(recommendation: TimeMachineRecommendation) {
    if (!onApply) return;
    setBusyId(recommendation.id);
    try {
      await onApply(recommendation);
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(recommendation: TimeMachineRecommendation) {
    if (!onDismiss) return;
    setBusyId(recommendation.id);
    try {
      await onDismiss(recommendation);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div
      className={`time-machine-card risk-${baseline.riskLevel.toLowerCase()}${compact ? ' compact' : ''}`}
      aria-live="polite"
    >
      <div className="tm-head">
        <div>
          <span className="tm-eyebrow">Time Machine</span>
          <h3 className="tm-probability">
            {percent(baseline.completionProbability)}
          </h3>
          <span className="tm-probability-label">
            {baseline.deadline
              ? 'chance of finishing on time'
              : 'chance of finishing within 7 days'}
          </span>
        </div>
        <div className="tm-head-meta">
          <span className={`tm-confidence tm-confidence-${baseline.confidence}`}>
            {confidenceLabel(baseline.confidence)}
          </span>
          <span className="tm-interval">
            Likely range {percent(baseline.interval[0])}–{percent(baseline.interval[1])}
          </span>
          {baseline.mode !== 'global' && (
            <span className="tm-mode">
              Based on {baseline.sampleSize} of your tasks
            </span>
          )}
        </div>
      </div>

      <div className="tm-window">
        <span>
          Expected finish: <strong>{formatDate(baseline.expectedCompletion?.p50 ?? null)}</strong>
        </span>
        <span className="tm-window-sep">·</span>
        <span>
          Safe window: <strong>{formatDate(baseline.expectedCompletion?.p80 ?? null)}</strong>
        </span>
      </div>

      {baseline.reasons.length > 0 && (
        <ul className="tm-reasons">
          {baseline.reasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
      )}

      {baseline.evidence.length > 0 && !compact && (
        <div className="tm-evidence">
          <span className="tm-evidence-label">Similar tasks</span>
          <ul>
            {baseline.evidence.map((entry) => (
              <li key={entry.taskId}>
                <span className="tm-evidence-text">{entry.text}</span>
                <span className="tm-evidence-meta">
                  {outcomeLabel(entry.outcome)}
                  {entry.durationDays !== null
                    ? ` · ${entry.durationDays} days`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {teamTask ? (
        <p className="tm-note">
          Team tasks use baseline estimates only. Recommendations stay personal
          for now.
        </p>
      ) : primary ? (
        <div className="tm-recommendation">
          <div className="tm-rec-head">
            <span className="tm-rec-label">{primary.label}</span>
            <span className="tm-rec-lift">
              {percent(primary.baselineProbability)} →{' '}
              {percent(primary.recommendedProbability)}{' '}
              <strong>({liftLabel(primary.lift)})</strong>
            </span>
          </div>
          {primary.reasons.length > 0 && (
            <ul className="tm-rec-reasons">
              {primary.reasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          )}
          <div className="tm-rec-meta">
            {primary.estimated ? 'Estimated from your history' : 'Suggested structure — estimate pending'}
            <span className="tm-meta-sep">·</span>
            {confidenceLabel(primary.confidence)}
          </div>
          <div className="tm-actions">
            <button
              type="button"
              className="tm-apply"
              disabled={busyId !== null}
              onClick={() => void apply(primary)}
            >
              {busyId === primary.id ? 'Applying…' : 'Apply change'}
            </button>
            {alternatives.length > 0 && (
              <button
                type="button"
                className="ghost-btn"
                onClick={() => setShowAlternatives((value) => !value)}
              >
                {showAlternatives ? 'Hide options' : 'See other options'}
              </button>
            )}
            <button
              type="button"
              className="ghost-btn tm-dismiss"
              disabled={busyId !== null}
              onClick={() => void dismiss(primary)}
            >
              Dismiss
            </button>
          </div>

          {showAlternatives && alternatives.length > 0 && (
            <ul className="tm-alternatives">
              {alternatives.map((alternative) => (
                <li key={alternative.id}>
                  <div className="tm-alt-copy">
                    <strong>{alternative.label}</strong>
                    <span>
                      {alternative.estimated
                        ? `${percent(alternative.baselineProbability)} → ${percent(alternative.recommendedProbability)} (${liftLabel(alternative.lift)})`
                        : 'Suggested structure — estimate pending'}
                    </span>
                  </div>
                  <div className="tm-alt-actions">
                    <button
                      type="button"
                      className="ghost-btn"
                      disabled={busyId !== null}
                      onClick={() => void apply(alternative)}
                    >
                      {busyId === alternative.id ? 'Applying…' : 'Apply'}
                    </button>
                    <button
                      type="button"
                      className="ghost-btn tm-dismiss"
                      disabled={busyId !== null}
                      onClick={() => void dismiss(alternative)}
                    >
                      Dismiss
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="tm-note">
          Your current plan looks solid. No change is likely to help much.
        </p>
      )}

      <div className="tm-footer">
        {baseline.sampleSize < 5
          ? `Still learning — ${learningGap} more completed task${learningGap === 1 ? '' : 's'} will improve this estimate.`
          : `Based on ${baseline.sampleSize} of your completed tasks.`}
      </div>
    </div>
  );
}
