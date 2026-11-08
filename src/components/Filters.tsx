import type { Filter } from '../../shared/types';

const LABELS: Record<Filter, string> = {
  all: 'All',
  active: 'Active',
  completed: 'Done',
};

interface Props {
  value: Filter;
  onChange: (filter: Filter) => void;
  total: number;
  active: number;
  done: number;
}

export function Filters({ value, onChange, total, active, done }: Props) {
  const counts: Record<Filter, number> = { all: total, active, completed: done };

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
