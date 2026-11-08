import { useMemo, useState, type FormEvent } from 'react';
import { composeDueAt, describeDue } from '../format';
import { CalendarIcon, PlusIcon } from './icons';

interface Props {
  onAdd: (text: string, dueAt: string | null) => Promise<boolean>;
}

function todayValue(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function TaskForm({ onAdd }: Props) {
  const [text, setText] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);

  const preview = useMemo(
    () => describeDue(composeDueAt(dueDate, dueTime), false),
    [dueDate, dueTime],
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (!value) {
      setShake(true);
      window.setTimeout(() => setShake(false), 320);
      return;
    }

    setBusy(true);
    const added = await onAdd(value, composeDueAt(dueDate, dueTime));
    setBusy(false);
    if (added) {
      setText('');
      setDueDate('');
      setDueTime('');
    }
  }

  function clearDeadline() {
    setDueDate('');
    setDueTime('');
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
          placeholder="What needs to be done?"
          aria-label="New task"
          autoFocus
        />
        <button className="add-btn" type="submit" disabled={busy}>
          <PlusIcon />
          <span>{busy ? 'Adding…' : 'Add'}</span>
        </button>
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
          <button type="button" className="clear-deadline" onClick={clearDeadline}>
            Clear
          </button>
        )}
      </div>
    </form>
  );
}
