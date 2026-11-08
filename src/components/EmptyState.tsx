import type { Filter } from '../../shared/types';
import { ClipboardIcon } from './icons';

interface Props {
  filter: Filter;
  total: number;
}

export function EmptyState({ filter, total }: Props) {
  const message =
    total === 0
      ? 'Nothing here yet. Add your first task above.'
      : filter === 'pending'
        ? 'All clear — no pending tasks. Nice work!'
        : filter === 'overdue'
          ? 'No overdue tasks. You are on top of things!'
          : filter === 'completed'
            ? 'No completed tasks yet.'
            : 'Nothing here yet. Add your first task above.';

  return (
    <div className="empty">
      <ClipboardIcon />
      <p>{message}</p>
    </div>
  );
}
