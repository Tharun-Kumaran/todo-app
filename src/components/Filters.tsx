import type { Filter } from '../../shared/types';

const LABELS: Record<Filter, string> = {
  all: 'All',
  pending: 'Pending',
  overdue: 'Overdue',
  completed: 'Completed',
};

interface Props {
  value: Filter;
  onChange: (filter: Filter) => void;
  total: number;
  pending: number;
  overdue: number;
  done: number;
}

export function Filters({
  value,
  onChange,
  total,
  pending,
  overdue,
  done,
}: Props) {
  const counts: Record<Filter, number> = {
    all: total,
    pending,
    overdue,
    completed: done,
  };

  return (
    <div className="filters" role="group" aria-label="Filter tasks">
      {(Object.keys(LABELS) as Filter[]).map((filter) => (
        <button
          key={filter}
          type="button"
          data-filter={filter}
          className={`filter${value === filter ? ' is-active' : ''}`}
          aria-pressed={value === filter}
          onClick={() => onChange(filter)}
        >
          {LABELS[filter]} <span className="filter-count">{counts[filter]}</span>
        </button>
      ))}
    </div>
  );
}
