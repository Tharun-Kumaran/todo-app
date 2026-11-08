export function ProgressBar({ percent }: { percent: number }) {
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label="Overall progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div style={{ width: `${percent}%` }} />
    </div>
  );
}
