import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { composeDueAt, describeDue } from '../format';
import { CalendarIcon, PlusIcon } from './icons';
import type {
  PredictionResponse,
  Priority,
  RecommendationOption,
  TaskCategory,
  TeamMember,
} from '../../shared/types';
import * as api from '../api';

interface Props {
  onAdd: (
    text: string,
    dueAt: string | null,
    assigneeEmail?: string | null,
    priority?: Priority | null,
    category?: TaskCategory | null,
  ) => Promise<boolean>;
  teamMembers?: TeamMember[];
}

const CATEGORIES: TaskCategory[] = [
  'Software Engineering',
  'Product Design',
  'DevOps & Infrastructure',
  'Data Engineering & AI',
  'Quality Assurance',
  'Finance & Compliance',
  'Operations',
  'Marketing & Content',
];

function todayValue(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function TaskForm({ onAdd, teamMembers }: Props) {
  const [text, setText] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [priority, setPriority] = useState<Priority>('Medium');
  const [category, setCategory] = useState<TaskCategory | ''>('');
  const [assigneeEmail, setAssigneeEmail] = useState('');
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);

  // Prediction engine state
  const [prediction, setPrediction] = useState<PredictionResponse | null>(null);
  const [isPredicting, setIsPredicting] = useState(false);

  const preview = useMemo(
    () => describeDue(composeDueAt(dueDate, dueTime), false),
    [dueDate, dueTime],
  );

  // Live prediction debounce effect
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed.length < 3) {
      setPrediction(null);
      return;
    }

    let active = true;
    setIsPredicting(true);

    const timer = window.setTimeout(async () => {
      try {
        const result = await api.predictTask({
          text: trimmed,
          dueAt: composeDueAt(dueDate, dueTime),
          priority,
          category: category ? (category as TaskCategory) : undefined,
        });
        if (active) {
          setPrediction(result);
          setIsPredicting(false);
        }
      } catch {
        if (active) {
          setIsPredicting(false);
        }
      }
    }, 350);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [text, dueDate, dueTime, priority, category]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (!value) {
      setShake(true);
      window.setTimeout(() => setShake(false), 320);
      return;
    }

    setBusy(true);
    const added = await onAdd(
      value,
      composeDueAt(dueDate, dueTime),
      assigneeEmail || null,
      priority,
      category ? (category as TaskCategory) : null,
    );
    setBusy(false);
    if (added) {
      setText('');
      setDueDate('');
      setDueTime('');
      setAssigneeEmail('');
      setPriority('Medium');
      setCategory('');
      setPrediction(null);
    }
  }

  function clearDeadline() {
    setDueDate('');
    setDueTime('');
  }

  function handleApplyRecommendation(rec: RecommendationOption) {
    if (rec.type === 'set_deadline' && rec.value) {
      const d = new Date(rec.value);
      const pad = (n: number) => String(n).padStart(2, '0');
      setDueDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
      setDueTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
    } else if (rec.type === 'change_priority' && rec.value) {
      setPriority(rec.value as Priority);
    } else if (rec.type === 'split_task') {
      if (!text.includes('[Part 1]')) {
        setText((prev) => `${prev} [Part 1/2]`);
      }
    }
  }

  return (
    <form
      className={`new-task${shake ? ' shake' : ''}`}
      onSubmit={(event) => void handleSubmit(event)}
      autoComplete="off"
    >
      <div className="new-task-row">
        <input
          id="new-task"
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={500}
          placeholder={
            teamMembers
              ? 'Add a team task for the project…'
              : 'What needs to be done?'
          }
          aria-label="New task"
          autoFocus
        />
        <button className="add-btn" type="submit" disabled={busy}>
          <PlusIcon />
          <span>{busy ? 'Adding…' : 'Add'}</span>
        </button>
      </div>

      <div className="task-config-row">
        <div className="task-select-wrap">
          <label htmlFor="task-priority">Priority:</label>
          <select
            id="task-priority"
            className={`priority-select priority-color-${priority.toLowerCase()}`}
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
          >
            <option value="Urgent">🔴 Urgent</option>
            <option value="High">🟠 High</option>
            <option value="Medium">🟡 Medium</option>
            <option value="Low">⚪ Low</option>
          </select>
        </div>

        <div className="task-select-wrap">
          <label htmlFor="task-category">Category:</label>
          <select
            id="task-category"
            className="category-select"
            value={category}
            onChange={(e) => setCategory(e.target.value as TaskCategory | '')}
          >
            <option value="">Auto-Detect ({prediction?.benchmark.category ?? 'General'})</option>
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
        </div>

        {teamMembers && teamMembers.length > 0 && (
          <div className="task-assignee-select-wrap">
            <label htmlFor="task-assignee">Assign to:</label>
            <select
              id="task-assignee"
              className="task-assignee-select"
              value={assigneeEmail}
              onChange={(e) => setAssigneeEmail(e.target.value)}
            >
              <option value="">Unassigned</option>
              {teamMembers.map((m) => (
                <option key={m.email} value={m.email}>
                  {m.email} {m.role === 'owner' ? '(Host)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="deadline-row">
        <span className="deadline-label">
          <CalendarIcon />
          Deadline
        </span>
        <input
          type="date"
          className="date-input"
          value={dueDate}
          min={todayValue()}
          aria-label="Deadline date"
          onChange={(event) => setDueDate(event.target.value)}
        />
        <input
          type="time"
          className="time-input"
          value={dueTime}
          aria-label="Deadline time"
          onChange={(event) => setDueTime(event.target.value)}
        />
        <span className="deadline-hint">
          {preview ? preview.label : dueDate ? 'Defaults to 11:59 PM' : 'Optional'}
        </span>
        {(dueDate || dueTime) && (
          <button
            type="button"
            className="clear-deadline"
            onClick={clearDeadline}
          >
            Clear
          </button>
        )}
      </div>

      {isPredicting && !prediction && (
        <div className="feasibility-card risk-low" style={{ opacity: 0.75 }}>
          <div className="feasibility-header">
            <span className="risk-badge-text">✨ Analyzing feasibility…</span>
          </div>
        </div>
      )}

      {prediction && (
        <div className={`feasibility-card risk-${prediction.riskLevel.toLowerCase()}`}>
          <div className="feasibility-header">
            <div className="feasibility-title">
              <span className={`risk-indicator indicator-${prediction.riskLevel.toLowerCase()}`} />
              <span className="risk-badge-text">
                {prediction.riskLevel === 'HIGH' && '⚠️ High Delay Risk'}
                {prediction.riskLevel === 'MEDIUM' && '⚡ Moderate Delay Risk'}
                {prediction.riskLevel === 'LOW' && '✅ On-Track / Feasible'}
              </span>
              <span className="risk-prob">
                {Math.round(prediction.delayProbability * 100)}% risk
                {isPredicting ? ' (updating…)' : ''}
              </span>
            </div>
            <div className="feasibility-meta">
              <span>
                Est. Duration: <strong>~{prediction.predictedDurationDays} days</strong>
              </span>
              <span className="meta-sep">•</span>
              <span>
                Action: <em>{prediction.benchmark.actionVerb}</em>
              </span>
            </div>
          </div>

          <div className="feasibility-reasons">
            {prediction.reasons.map((reason, idx) => (
              <div key={idx} className="reason-item">
                <span className="reason-bullet">›</span>
                <span>{reason}</span>
              </div>
            ))}
          </div>

          {prediction.recommendations.length > 0 && (
            <div className="feasibility-actions">
              <span className="actions-label">✨ AI Suggestions:</span>
              <div className="action-buttons">
                {prediction.recommendations.map((rec) => (
                  <button
                    key={rec.id}
                    type="button"
                    className="rec-action-btn"
                    onClick={() => handleApplyRecommendation(rec)}
                  >
                    {rec.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
