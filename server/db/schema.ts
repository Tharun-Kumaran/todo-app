/**
 * Postgres-first schema shared by PGlite (local development and tests) and a
 * managed Postgres instance in production.
 *
 * Rules:
 * - No extensions. UUIDs are generated in Node.
 * - Emails are normalized in the application; uniqueness uses lower(email).
 * - Every task mutation writes a task_events row in the same transaction.
 * - `sort_order` is an application concern used to preserve the current list
 *   ordering that the JSON store provided.
 */
export const INITIAL_SCHEMA_VERSION = '001_initial';

export const INITIAL_SCHEMA_SQL = `
create table if not exists users (
  id uuid primary key,
  email text not null,
  password_hash text not null,
  email_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  deleted_at timestamptz
);
create unique index if not exists users_email_lower_uq
  on users (lower(email)) where deleted_at is null;

create table if not exists sessions (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text,
  ip_hash text
);
create index if not exists sessions_user_expiry_idx
  on sessions (user_id, expires_at desc);

create table if not exists email_tokens (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('verify_email', 'reset_password', 'change_email')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists email_tokens_user_kind_idx
  on email_tokens (user_id, kind, created_at desc);

create table if not exists invites (
  id uuid primary key,
  code_hash text not null unique,
  email text,
  created_by uuid references users(id) on delete set null,
  max_uses int not null default 1 check (max_uses > 0),
  used_count int not null default 0 check (used_count >= 0),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists teams (
  id uuid primary key,
  name text not null,
  owner_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists team_members (
  team_id uuid not null references teams(id) on delete cascade,
  email text not null,
  user_id uuid references users(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (team_id, email)
);
create unique index if not exists team_members_user_uq
  on team_members (team_id, user_id) where user_id is not null;

create table if not exists tasks (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  team_id uuid references teams(id) on delete set null,
  creator_email text,
  assignee_email text,
  assignee_user_id uuid references users(id) on delete set null,
  text text not null,
  done boolean not null default false,
  progress int not null default 0 check (progress between 0 and 100),
  priority text check (priority in ('Low', 'Medium', 'High', 'Urgent')),
  category text,
  due_at timestamptz,
  scheduled_start_at timestamptz,
  reminder_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  series_id uuid,
  occurrence_at timestamptz,
  source text not null default 'manual' check (source in ('manual', 'recurrence', 'import')),
  recommendation_holdout boolean not null default false,
  version int not null default 1,
  idempotency_key text,
  sort_order int not null default 0
);
create index if not exists tasks_user_created_idx
  on tasks (user_id, deleted_at, created_at desc);
create index if not exists tasks_team_idx
  on tasks (team_id, deleted_at) where team_id is not null;
create index if not exists tasks_open_due_idx
  on tasks (due_at) where done = false and deleted_at is null;
create unique index if not exists tasks_idempotency_uq
  on tasks (user_id, idempotency_key) where idempotency_key is not null;

create table if not exists task_milestones (
  id uuid primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  text text not null,
  progress int not null check (progress between 0 and 100),
  created_at timestamptz not null default now()
);
create index if not exists task_milestones_task_idx
  on task_milestones (task_id, created_at);

create table if not exists task_events (
  id bigint generated always as identity primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  actor_user_id uuid references users(id) on delete set null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists task_events_task_idx
  on task_events (task_id, occurred_at);
create index if not exists task_events_user_type_idx
  on task_events (user_id, type, occurred_at desc);

create table if not exists predictions (
  id uuid primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in (
    'completion_by_deadline', 'completion_window', 'overdue_risk', 'recommendation_lift'
  )),
  model_version text not null,
  p numeric(6,5) not null check (p between 0 and 1),
  p_low numeric(6,5) check (p_low between 0 and 1),
  p_high numeric(6,5) check (p_high between 0 and 1),
  predicted_completion_at timestamptz,
  window_start timestamptz,
  window_end timestamptz,
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  sample_size int not null default 0,
  features jsonb not null default '{}'::jsonb,
  reasons jsonb not null default '[]'::jsonb,
  mode text check (mode in ('personal', 'blended', 'global')),
  holdout boolean not null default false,
  label int check (label in (0, 1)),
  labeled_at timestamptz,
  outcome_status text,
  created_at timestamptz not null default now(),
  superseded_at timestamptz
);
create index if not exists predictions_task_idx
  on predictions (task_id, created_at desc);
create index if not exists predictions_user_idx
  on predictions (user_id, created_at desc);

create table if not exists prediction_outcomes (
  prediction_id uuid primary key references predictions(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  label int check (label in (0, 1)),
  outcome_status text not null,
  resolved_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists prediction_outcomes_user_idx
  on prediction_outcomes (user_id, resolved_at desc);

create table if not exists task_outcomes (
  id uuid primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  horizon text not null check (horizon in ('24h', '7d', 'deadline', '30d')),
  status text not null check (status in (
    'pending', 'completed_on_time', 'completed_late', 'overdue',
    'abandoned', 'deleted_before_due', 'deleted_after_due', 'reopened'
  )),
  observed_at timestamptz not null,
  resolved_at timestamptz not null default now(),
  revision int not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  unique (task_id, horizon)
);
create index if not exists task_outcomes_user_status_idx
  on task_outcomes (user_id, status, observed_at desc);

create table if not exists recommendations (
  id uuid primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  prediction_id uuid references predictions(id) on delete set null,
  type text not null check (type in (
    'deadline_change', 'schedule_window', 'split_subtasks', 'reminder', 'recurrence_series'
  )),
  payload jsonb not null,
  baseline_p numeric(6,5) not null check (baseline_p between 0 and 1),
  recommended_p numeric(6,5) not null check (recommended_p between 0 and 1),
  lift numeric(6,5) not null check (lift between -1 and 1),
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  rank int not null default 0,
  status text not null default 'active' check (status in (
    'active', 'accepted', 'dismissed', 'expired', 'superseded'
  )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz,
  resolved_at timestamptz,
  dismissed_reason text,
  cooldown_until timestamptz
);
create index if not exists recommendations_task_status_idx
  on recommendations (task_id, status, created_at desc);

create table if not exists recommendation_events (
  id bigint generated always as identity primary key,
  recommendation_id uuid not null references recommendations(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  event text not null check (event in (
    'shown', 'accepted', 'dismissed', 'applied', 'expired', 'superseded'
  )),
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists recommendation_events_rec_idx
  on recommendation_events (recommendation_id, occurred_at);

create table if not exists task_series (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  team_id uuid references teams(id) on delete set null,
  title text not null,
  rrule text not null,
  timezone text not null,
  next_occurrence_at timestamptz,
  auto_create boolean not null default false,
  status text not null default 'suggested' check (status in (
    'suggested', 'active', 'paused', 'ended'
  )),
  detection_confidence numeric(4,3) check (detection_confidence between 0 and 1),
  sample_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists task_series_user_status_idx
  on task_series (user_id, status);

create table if not exists series_occurrences (
  series_id uuid not null references task_series(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  occurrence_at timestamptz not null,
  primary key (series_id, task_id)
);

create table if not exists reminders (
  id uuid primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  remind_at timestamptz not null,
  channel text not null default 'in_app' check (channel in ('in_app', 'email')),
  status text not null default 'scheduled' check (status in (
    'scheduled', 'sent', 'dismissed', 'cancelled'
  )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists reminders_due_idx
  on reminders (status, remind_at);

create table if not exists user_settings (
  user_id uuid primary key references users(id) on delete cascade,
  timezone text not null default 'UTC',
  locale text not null default 'en',
  prediction_enabled boolean not null default true,
  recommendations_enabled boolean not null default true,
  shared_learning_opt_in boolean not null default false,
  llm_opt_in boolean not null default false,
  recurrence_auto_create_default boolean not null default false,
  email_reminders_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists user_model_state (
  user_id uuid primary key references users(id) on delete cascade,
  model_version text not null,
  sample_count int not null default 0,
  effective_sample_count numeric(10,3) not null default 0,
  calibration_a numeric(8,4) not null default 1,
  calibration_b numeric(8,4) not null default 0,
  stats jsonb not null default '{}'::jsonb,
  last_outcome_at timestamptz,
  last_calibrated_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists shared_training_rows (
  id bigint generated always as identity primary key,
  user_id uuid not null references users(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  feature_hash text not null,
  features jsonb not null,
  label int not null check (label in (0, 1)),
  outcome_status text not null,
  created_at timestamptz not null default now(),
  unique (user_id, task_id)
);
create index if not exists shared_training_rows_user_idx
  on shared_training_rows (user_id);

create table if not exists global_model_state (
  model_version text primary key,
  stats jsonb not null,
  sample_count int not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists model_versions (
  version text primary key,
  kind text not null,
  trained_at timestamptz not null,
  training_window_start timestamptz,
  training_window_end timestamptz,
  metrics jsonb not null default '{}'::jsonb,
  status text not null check (status in ('shadow', 'active', 'retired')),
  notes text
);

create table if not exists jobs (
  id uuid primary key,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  run_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  attempts int not null default 0,
  max_attempts int not null default 5,
  status text not null default 'pending' check (status in (
    'pending', 'running', 'done', 'failed', 'dead'
  )),
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists jobs_ready_idx
  on jobs (run_at) where status = 'pending';

create table if not exists email_outbox (
  id uuid primary key,
  user_id uuid references users(id) on delete set null,
  to_email text not null,
  template text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts int not null default 0,
  last_error text,
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists email_outbox_due_idx
  on email_outbox (status, scheduled_at);

create table if not exists rate_limit_events (
  id bigint generated always as identity primary key,
  bucket text not null,
  occurred_at timestamptz not null default now()
);
create index if not exists rate_limit_events_bucket_idx
  on rate_limit_events (bucket, occurred_at desc);

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  user_id uuid references users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  ip_hash text,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_user_idx
  on audit_log (user_id, created_at desc);

create table if not exists idempotency_keys (
  user_id uuid not null references users(id) on delete cascade,
  key text not null,
  route text not null,
  response_status int,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (user_id, key, route)
);
`;
