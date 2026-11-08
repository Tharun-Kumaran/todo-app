import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { Task, TeamMember } from '../../shared/types';
import {
  describeDue,
  formatDateTime,
  formatMilestoneTime,
  fromDateTimeLocal,
  toDateTimeLocal,
} from '../format';
import { CalendarIcon, CheckIcon, ChevronIcon, TrashIcon } from './icons';

interface Props {
  task: Task;
  draggable: boolean;
  dragging: boolean;
  dragOver: boolean;
  teamMembers?: TeamMember[];
  onToggle: () => void;
  onEdit: (text: string) => Promise<boolean>;
  onAssignee?: (email: string | null) => Promise<boolean>;
  onProgress: (progress: number) => Promise<boolean>;
  onDue: (dueAt: string | null) => Promise<boolean>;
  onMilestone: (text: string, progress: number) => Promise<boolean>;
  onDelete: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

export function TaskItem({
  task,
  draggable,
  dragging,
  dragOver,
  teamMembers,
  onToggle,
  onEdit,
  onAssignee,
  onProgress,
  onDue,
  onMilestone,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.text);
  const [expanded, setExpanded] = useState(false);
  const [progressDraft, setProgressDraft] = useState(task.progress);
  const [progressBusy, setProgressBusy] = useState(false);
  const [dueDraft, setDueDraft] = useState(toDateTimeLocal(task.dueAt));
  const [dueBusy, setDueBusy] = useState(false);
  const [milestoneText, setMilestoneText] = useState('');
  const [milestoneProgress, setMilestoneProgress] = useState(task.progress);
  const [milestoneBusy, setMilestoneBusy] = useState(false);
  const [assigneeBusy, setAssigneeBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const editingRef = useRef(false);
  const cancelRef = useRef(false);

  const due = describeDue(task.dueAt, task.done);
  const detailsId = `task-details-${task.id}`;
  const status = task.done
    ? 'Completed'
    : due?.tone === 'overdue'
      ? 'Overdue'
      : 'Pending';

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(task.text);
  }, [task.text, editing]);

  useEffect(() => {
    setProgressDraft(task.progress);
    setMilestoneProgress(task.progress);
  }, [task.progress]);

  useEffect(() => {
    setDueDraft(toDateTimeLocal(task.dueAt));
  }, [task.dueAt]);

  function openEditor() {
    editingRef.current = true;
    setDraft(task.text);
    setEditing(true);
  }

  function closeEditor() {
    editingRef.current = false;
    cancelRef.current = false;
    setEditing(false);
  }

  async function commitEdit() {
    if (!editingRef.current || cancelRef.current) return;
    const value = draft.trim();
    if (!value || value === task.text) {
      setDraft(task.text);
      closeEditor();
      return;
    }
    const saved = await onEdit(value);
    if (saved) closeEditor();
    else setDraft(task.text);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commitEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelRef.current = true;
      setDraft(task.text);
      closeEditor();
    }
  }

  function handleBlur() {
    if (cancelRef.current) return;
    void commitEdit();
  }

  async function commitProgress(value: number) {
    const clamped = Math.min(100, Math.max(0, Math.round(value)));
    if (clamped === task.progress) return;
    setProgressBusy(true);
    const saved = await onProgress(clamped);
    setProgressBusy(false);
    if (!saved) setProgressDraft(task.progress);
  }

  async function saveDue() {
    if (dueDraft && !fromDateTimeLocal(dueDraft)) return;
    setDueBusy(true);
    const saved = await onDue(fromDateTimeLocal(dueDraft));
    setDueBusy(false);
    if (!saved) setDueDraft(toDateTimeLocal(task.dueAt));
  }

  async function clearDue() {
    setDueDraft('');
    setDueBusy(true);
    const saved = await onDue(null);
    setDueBusy(false);
    if (!saved) setDueDraft(toDateTimeLocal(task.dueAt));
  }

  async function handleAssigneeChange(email: string) {
    if (!onAssignee) return;
    setAssigneeBusy(true);
    await onAssignee(email || null);
    setAssigneeBusy(false);
  }

  async function submitMilestone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = milestoneText.trim();
    if (!text || milestoneBusy) return;

    setMilestoneBusy(true);
    const saved = await onMilestone(
      text,
      Math.min(100, Math.max(0, Math.round(milestoneProgress))),
    );
    setMilestoneBusy(false);
    if (saved) setMilestoneText('');
  }

  const className = [
    'task',
    task.done ? 'done' : '',
    expanded ? 'expanded' : '',
    dragging ? 'dragging' : '',
    dragOver ? 'drag-over' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li
      className={className}
      draggable={draggable && !editing && !expanded}
      onDragStart={(event) => {
        if (!draggable || editing || expanded) return;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', task.id);
        onDragStart();
      }}
      onDragOver={(event) => {
        if (!draggable) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        onDragOver();
      }}
      onDrop={(event) => {
        if (!draggable) return;
        event.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
    >
      <div className="task-main">
        <button
          type="button"
          className="check"
          role="checkbox"
          aria-checked={task.done}
          aria-label={`${task.done ? 'Mark as not done' : 'Mark as done'}: ${task.text}`}
          onClick={onToggle}
        >
          <CheckIcon />
        </button>

        {editing ? (
          <input
            ref={inputRef}
            className="edit-input"
            value={draft}
            maxLength={500}
            aria-label="Edit task"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
          />
        ) : (
          <span
            className="task-text"
            title="Double-click to edit"
            onDoubleClick={openEditor}
          >
            {task.text}
          </span>
        )}

        {task.assigneeEmail && (
          <span
            className="assignee-badge"
            title={`Assigned to ${task.assigneeEmail}`}
          >
            👤 {task.assigneeEmail.split('@')[0]}
          </span>
        )}

        {due && !editing && (
          <span className={`due-badge tone-${due.tone}`} title={due.title}>
            <CalendarIcon />
            {due.label}
          </span>
        )}

        <button
          type="button"
          className="details-toggle"
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={`Progress ${task.progress}% and updates for: ${task.text}`}
          title="Progress, deadline and updates"
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="mini-track" aria-hidden="true">
            <span style={{ width: `${task.progress}%` }} />
          </span>
          <span className="mini-value">{task.progress}%</span>
          {task.milestones.length > 0 && (
            <span
              className="mini-count"
              title={`${task.milestones.length} progress updates`}
            >
              {task.milestones.length}
            </span>
          )}
          <ChevronIcon />
        </button>

        <button
          type="button"
          className="delete"
          aria-label={`Delete task: ${task.text}`}
          title="Delete"
          onClick={onDelete}
        >
          <TrashIcon />
        </button>
      </div>

      {expanded && (
        <div className="task-details" id={detailsId}>
          <div className="details-row">
            <section className="detail-card">
              <div className="detail-head">
                <h3>Progress</h3>
                <span className="detail-value">{progressDraft}%</span>
              </div>
              <input
                type="range"
                className="progress-range"
                min={0}
                max={100}
                step={5}
                value={progressDraft}
                aria-label="Task progress"
                onChange={(event) =>
                  setProgressDraft(Number(event.target.value))
                }
                onPointerUp={() => void commitProgress(progressDraft)}
                onKeyUp={() => void commitProgress(progressDraft)}
                disabled={progressBusy}
              />
              <div className="detail-actions">
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => void commitProgress(progressDraft)}
                  disabled={progressBusy || progressDraft === task.progress}
                >
                  {progressBusy ? 'Saving…' : 'Save progress'}
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => void commitProgress(100)}
                  disabled={progressBusy || task.done}
                >
                  Mark 100%
                </button>
              </div>
            </section>

            <section className="detail-card">
              <div className="detail-head">
                <h3>Deadline</h3>
                <span className={`detail-count tone-${due?.tone ?? 'future'}`}>
                  {due ? due.label : 'None'}
                </span>
              </div>
              <input
                type="datetime-local"
                className="due-input"
                value={dueDraft}
                aria-label="Task deadline"
                onChange={(event) => setDueDraft(event.target.value)}
                disabled={dueBusy}
              />
              <div className="detail-actions">
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => void saveDue()}
                  disabled={dueBusy || dueDraft === toDateTimeLocal(task.dueAt)}
                >
                  {dueBusy ? 'Saving…' : 'Save deadline'}
                </button>
                {task.dueAt && (
                  <button
                    type="button"
                    className="ghost-btn danger"
                    onClick={() => void clearDue()}
                    disabled={dueBusy}
                  >
                    Clear
                  </button>
                )}
              </div>
            </section>
          </div>

          <section className="detail-card">
            <div className="detail-head">
              <h3>Task info</h3>
              <span className={`detail-count status-${status.toLowerCase()}`}>
                {status}
              </span>
            </div>
            <dl className="meta-grid">
              <div>
                <dt>Created</dt>
                <dd>{formatDateTime(task.createdAt)}</dd>
              </div>
              <div>
                <dt>Last updated</dt>
                <dd>{formatDateTime(task.updatedAt)}</dd>
              </div>
              <div>
                <dt>Completed</dt>
                <dd>
                  {task.completedAt
                    ? formatDateTime(task.completedAt)
                    : 'Not completed'}
                </dd>
              </div>
              <div>
                <dt>Deadline</dt>
                <dd>{task.dueAt ? formatDateTime(task.dueAt) : 'None'}</dd>
              </div>
              {task.creatorEmail && (
                <div>
                  <dt>Created by</dt>
                  <dd>{task.creatorEmail}</dd>
                </div>
              )}
              {teamMembers && (
                <div>
                  <dt>Assignee</dt>
                  <dd>
                    <select
                      className="inline-assignee-select"
                      value={task.assigneeEmail || ''}
                      disabled={assigneeBusy}
                      onChange={(e) =>
                        void handleAssigneeChange(e.target.value)
                      }
                    >
                      <option value="">Unassigned</option>
                      {teamMembers.map((m) => (
                        <option key={m.email} value={m.email}>
                          {m.email}
                        </option>
                      ))}
                    </select>
                  </dd>
                </div>
              )}
            </dl>
          </section>

          <section className="detail-card">
            <div className="detail-head">
              <h3>Progress updates</h3>
              <span className="detail-count">
                {task.milestones.length === 0
                  ? 'None yet'
                  : `${task.milestones.length} logged`}
              </span>
            </div>

            <form
              className="milestone-form"
              onSubmit={(event) => void submitMilestone(event)}
            >
              <input
                className="milestone-input"
                value={milestoneText}
                maxLength={1000}
                placeholder="What did you get done?"
                aria-label="Progress update"
                onChange={(event) => setMilestoneText(event.target.value)}
              />
              <div className="milestone-controls">
                <label className="milestone-progress">
                  Log at
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={5}
                    value={milestoneProgress}
                    aria-label="Completion percentage for this update"
                    onChange={(event) =>
                      setMilestoneProgress(Number(event.target.value))
                    }
                  />
                  %
                </label>
                <button
                  type="submit"
                  className="post-btn"
                  disabled={milestoneBusy || !milestoneText.trim()}
                >
                  {milestoneBusy ? 'Posting…' : 'Post update'}
                </button>
              </div>
            </form>

            {task.milestones.length > 0 && (
              <ol className="milestones">
                {task.milestones
                  .slice()
                  .reverse()
                  .map((milestone) => (
                    <li key={milestone.id} className="milestone">
                      <span className="milestone-badge">{milestone.progress}%</span>
                      <div className="milestone-body">
                        <p>{milestone.text}</p>
                        <time dateTime={milestone.createdAt}>
                          {formatMilestoneTime(milestone.createdAt)}
                        </time>
                      </div>
                    </li>
                  ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </li>
  );
}
