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
      : filter === 'active'
        ? 'All clear — no active tasks. Nice work!'
        : 'No completed tasks yet.';

  return (
    <div className="empty">
      <ClipboardIcon />
      <p>{message}</p>
    </div>
  );
}
