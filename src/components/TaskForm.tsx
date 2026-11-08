import { useState, type FormEvent } from 'react';
import { PlusIcon } from './icons';

interface Props {
  onAdd: (text: string) => Promise<boolean>;
}

export function TaskForm({ onAdd }: Props) {
  const [text, setText] = useState('');
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (!value) {
      setShake(true);
      window.setTimeout(() => setShake(false), 320);
      return;
    }

    setBusy(true);
    const added = await onAdd(value);
    setBusy(false);
    if (added) setText('');
  }

  return (
    <form
      className={`new-task${shake ? ' shake' : ''}`}
      onSubmit={(event) => void handleSubmit(event)}
      autoComplete="off"
    >
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
    </form>
  );
}
