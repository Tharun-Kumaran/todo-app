import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Task } from '../../shared/types';
import { CheckIcon, TrashIcon } from './icons';

interface Props {
  task: Task;
  draggable: boolean;
  dragging: boolean;
  dragOver: boolean;
  onToggle: () => void;
  onEdit: (text: string) => Promise<boolean>;
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
  onToggle,
  onEdit,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.text);
  const inputRef = useRef<HTMLInputElement>(null);
  const editingRef = useRef(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(task.text);
  }, [task.text, editing]);

  function openEditor() {
    editingRef.current = true;
    setDraft(task.text);
    setEditing(true);
  }

  function closeEditor() {
    editingRef.current = false;
    setEditing(false);
  }

  async function commit() {
    if (!editingRef.current) return;
    editingRef.current = false;
    setEditing(false);

    const value = draft.trim();
    if (!value || value === task.text) {
      setDraft(task.text);
      return;
    }

    const saved = await onEdit(value);
    if (!saved) setDraft(task.text);
  }

  function handleBlur() {
    if (cancelRef.current) {
      cancelRef.current = false;
      return;
    }
    void commit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelRef.current = true;
      setDraft(task.text);
      closeEditor();
    }
  }

  const className = [
    'task',
    task.done ? 'done' : '',
    dragging ? 'dragging' : '',
    dragOver ? 'drag-over' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li
      className={className}
      draggable={draggable && !editing}
      onDragStart={(event) => {
        if (!draggable) return;
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

      <button
        type="button"
        className="delete"
        aria-label={`Delete task: ${task.text}`}
        title="Delete"
        onClick={onDelete}
      >
        <TrashIcon />
      </button>
    </li>
  );
}
