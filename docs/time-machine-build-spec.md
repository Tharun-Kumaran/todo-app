# Time Machine v2 — Build Specification

**Status:** Draft for approval  
**Baseline:** `9beb980` (auth, teams, and first-generation prediction engine)  
**Scope:** Public multi-user to-do product with per-user forecasting, recommendation lift, and outcome learning.  
**Audience:** Engineering implementation and product review.

---

## 1. Locked decisions

These are the decisions already made in discussion. They are constraints, not open questions.

| Area | Decision |
|---|---|
| Product | Public multi-user product; invite-only beta first. |
| Auth | Keep self-hosted email/password auth; harden it for public launch. |
| Database | Postgres in production. Local development and tests use PGlite (Postgres in WASM) so Docker/`psql` are not required. |
| Prediction | Statistical per-user model in v1. No LLM-generated probabilities. |
| Core UX | Show the current timeline's probability, a recommended timeline's probability, and the lift. |
| Recommendation actions | Deadline changes, scheduling windows, subtasks, reminders, and recurrence series. |
| Recurrence | Suggest first; auto-create only after the user opts in per series. |
| Outcomes | Multi-signal: on-time, late, overdue, abandoned, reopened, deleted, recommendation accepted/dismissed. |
| Learning | Per-user online statistics, decay, calibration, and nightly backtesting. No LLM fine-tuning. |
| Privacy | Per-user choice. Personal-history predictions on by default; shared/global learning off by default; LLM opt-in off by default. |
| LLM | Deferred. Optional opt-in layer later for language understanding, subtask generation, and explanations. Never the sole source of a numeric prediction. |
| Team tasks | Baseline prediction only in v1. Recommendations are personal-task-only until team dependencies are modeled. |

---

## 2. Goals and non-goals

### Goals

1. Every task has an owner, an append-only event history, prediction snapshots, and resolved outcomes.
2. The app answers two questions on every task:
   - **Current plan:** how likely is this to be completed by its deadline?
   - **Recommended plan:** what change would improve that probability, and by how much?
3. The model learns from this user's real outcomes first, then optionally from opted-in aggregate data.
4. Predictions are calibrated, explainable, and honest about low sample sizes.
5. The product is safe enough for a public invite-only beta: verified email, password reset, rate limits, session revocation, export/delete, backups, and monitoring.

### Non-goals for v1

- LLM-generated probabilities or autonomous task execution.
- Team-level causal recommendations, dependency graphs, or resource leveling.
- Native mobile apps.
- Full project-management features (Gantt, sprints, workload planning).
- Cross-user raw-text sharing. Shared learning uses only minimized feature rows.
- Real-time collaborative editing beyond the current team sync behavior.

---

## 3. Architecture

```
Browser (React + Vite)
        │  same-origin HTTPS, HttpOnly session cookie
        ▼
Express API  ──────────────►  Postgres
        │                      (tasks, events, predictions,
        │                       recommendations, outcomes,
        │                       model state, jobs, email outbox)
        │
        ├── Time Machine service (pure model + feature builder)
        ├── Outcome resolver (scheduled job)
        ├── Recommendation engine (candidates + scoring + holdout)
        ├── Job runner (in-process for beta, Postgres-locked)
        └── Email adapter (console in dev, provider in production)
                 │
                 └── Optional LLM adapter (Phase 7, opt-in only)
```

### Layers

| Layer | Responsibility |
|---|---|
| Routes | HTTP validation, auth, status codes, response shapes. No business logic. |
| Services | Auth, tasks, teams, time machine, recommendations, outcomes, account. |
| Repositories | Drizzle queries and transactions. All user scoping lives here. |
| Model | Pure functions: features → probability, window, confidence, explanations. No I/O. |
| Jobs | Idempotent background work with retries and a dead-letter state. |
| Config | Fail-fast environment validation; feature flags. |

### Principles

- **Predictions are snapshots.** Never overwrite a prediction; mark it superseded and insert a new one.
- **Events are append-only.** Task state is current; `task_events` is history.
- **Transactions cover state + event.** A task mutation and its event commit together.
- **UTC in the database.** Convert at the edges using the user's timezone.
- **Pure model functions.** The same inputs produce the same output and can be backtested offline.
- **Feature flags for every new surface.** `TIME_MACHINE_V2`, `RECOMMENDATIONS`, `RECURRENCE`, `SHARED_LEARNING`, `LLM`.
- **No cross-user reads without an explicit scope.** Repository methods take `userId` (or a verified team membership) as the first argument.

---

## 4. Data model

The schema is Postgres-first and avoids extensions so it runs on both managed Postgres and PGlite. UUIDs are generated in Node, not by the database. Emails are normalized to lowercase in the application; uniqueness is enforced with a `lower(email)` index.

### 4.1 Identity, sessions, and invitations

```sql
create table users (
  id uuid primary key,
  email text not null,
  -- PHC-style scrypt string: scrypt$N$r$p$salt$hash
  password_hash text not null,
  email_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  deleted_at timestamptz
);
create unique index users_email_lower_uq
  on users (lower(email)) where deleted_at is null;

create table sessions (
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
create index sessions_user_expiry_idx on sessions (user_id, expires_at desc);

create table email_tokens (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('verify_email', 'reset_password', 'change_email')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index email_tokens_user_kind_idx on email_tokens (user_id, kind, created_at desc);

create table invites (
  id uuid primary key,
  code_hash text not null unique,
  email text,
  created_by uuid references users(id) on delete set null,
  max_uses int not null default 1 check (max_uses > 0),
  used_count int not null default 0 check (used_count >= 0),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
```

### 4.2 Teams and tasks

```sql
create table teams (
  id uuid primary key,
  name text not null,
  owner_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table team_members (
  team_id uuid not null references teams(id) on delete cascade,
  email text not null,
  user_id uuid references users(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (team_id, email)
);
create unique index team_members_user_uq
  on team_members (team_id, user_id) where user_id is not null;

create table tasks (
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
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  series_id uuid,
  occurrence_at timestamptz,
  source text not null default 'manual' check (source in ('manual', 'recurrence', 'import')),
  recommendation_holdout boolean not null default false,
  version int not null default 1,
  idempotency_key text
);
create index tasks_user_created_idx
  on tasks (user_id, deleted_at, created_at desc);
create index tasks_team_idx
  on tasks (team_id, deleted_at) where team_id is not null;
create index tasks_open_due_idx
  on tasks (due_at) where done = false and deleted_at is null;
create unique index tasks_idempotency_uq
  on tasks (user_id, idempotency_key) where idempotency_key is not null;

create table task_milestones (
  id uuid primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  text text not null,
  progress int not null check (progress between 0 and 100),
  created_at timestamptz not null default now()
);
create index task_milestones_task_idx on task_milestones (task_id, created_at);
```

### 4.3 Event history

```sql
create table task_events (
  id bigint generated always as identity primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  actor_user_id uuid references users(id) on delete set null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index task_events_task_idx on task_events (task_id, occurred_at);
create index task_events_user_type_idx on task_events (user_id, type, occurred_at desc);
```

Event types emitted by the task service:

| Type | When | Payload examples |
|---|---|---|
| `task.created` | Task inserted | `{ dueAt, priority, category, source }` |
| `task.text_changed` | Text edited | `{ before, after }` |
| `task.due_changed` | Deadline set/moved/cleared | `{ before, after, shiftCount }` |
| `task.priority_changed` | Priority edited | `{ before, after }` |
| `task.category_changed` | Category edited | `{ before, after }` |
| `task.assignee_changed` | Team assignment changed | `{ before, after }` |
| `task.progress_changed` | Progress updated | `{ before, after }` |
| `task.milestone_added` | Milestone posted | `{ milestoneId, progress }` |
| `task.completed` | Done transition | `{ completedAt, dueAt, late }` |
| `task.reopened` | Completed → open | `{ completedAt, reopenedAt }` |
| `task.deleted` | Soft delete | `{ dueAt, done }` |
| `task.restored` | Undo delete | `{}` |
| `task.series_linked` | Task linked to a series | `{ seriesId, occurrenceAt }` |
| `recommendation.applied` | Recommendation changed the task | `{ recommendationId, type, before, after }` |

### 4.4 Predictions and outcomes

```sql
create table predictions (
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
  created_at timestamptz not null default now(),
  superseded_at timestamptz
);
create index predictions_task_idx on predictions (task_id, created_at desc);
create index predictions_user_idx on predictions (user_id, created_at desc);

create table prediction_outcomes (
  prediction_id uuid primary key references predictions(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  label int check (label in (0, 1)),
  outcome_status text not null,
  resolved_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index prediction_outcomes_user_idx
  on prediction_outcomes (user_id, resolved_at desc);

create table task_outcomes (
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
create index task_outcomes_user_status_idx
  on task_outcomes (user_id, status, observed_at desc);
```

### 4.5 Recommendations

```sql
create table recommendations (
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
  expires_at timestamptz,
  resolved_at timestamptz
);
create index recommendations_task_status_idx
  on recommendations (task_id, status, created_at desc);

create table recommendation_events (
  id bigint generated always as identity primary key,
  recommendation_id uuid not null references recommendations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  event text not null check (event in (
    'shown', 'accepted', 'dismissed', 'applied', 'expired', 'superseded'
  )),
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index recommendation_events_rec_idx
  on recommendation_events (recommendation_id, occurred_at);
```

### 4.6 Recurrence, reminders, and series

```sql
create table task_series (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  team_id uuid references teams(id) on delete set null,
  title text not null,
  -- RFC 5545 subset: FREQ=WEEKLY;BYDAY=SU, FREQ=DAILY, FREQ=MONTHLY;BYMONTHDAY=1
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
create index task_series_user_status_idx on task_series (user_id, status);

create table series_occurrences (
  series_id uuid not null references task_series(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  occurrence_at timestamptz not null,
  primary key (series_id, task_id)
);

create table reminders (
  id uuid primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  remind_at timestamptz not null,
  channel text not null default 'in_app' check (channel in ('in_app', 'email')),
  status text not null default 'scheduled' check (status in (
    'scheduled', 'sent', 'dismissed', 'cancelled'
  )),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index reminders_due_idx on reminders (status, remind_at);
```

### 4.7 Model state, shared learning, and versions

```sql
create table user_settings (
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

create table user_model_state (
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

create table shared_training_rows (
  id bigint generated always as identity primary key,
  user_id uuid not null references users(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  feature_hash text not null,
  -- Minimized features only: no raw text, no email, no names.
  features jsonb not null,
  label int not null check (label in (0, 1)),
  outcome_status text not null,
  created_at timestamptz not null default now(),
  unique (user_id, task_id)
);
create index shared_training_rows_user_idx on shared_training_rows (user_id);

create table global_model_state (
  model_version text primary key,
  stats jsonb not null,
  sample_count int not null default 0,
  updated_at timestamptz not null default now()
);

create table model_versions (
  version text primary key,
  kind text not null,
  trained_at timestamptz not null,
  training_window_start timestamptz,
  training_window_end timestamptz,
  metrics jsonb not null default '{}'::jsonb,
  status text not null check (status in ('shadow', 'active', 'retired')),
  notes text
);
```

### 4.8 Jobs, email, rate limits, audit, and idempotency

```sql
create table jobs (
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
create index jobs_ready_idx on jobs (run_at) where status = 'pending';

create table email_outbox (
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
create index email_outbox_due_idx on email_outbox (status, scheduled_at);

create table rate_limit_events (
  id bigint generated always as identity primary key,
  bucket text not null,
  occurred_at timestamptz not null default now()
);
create index rate_limit_events_bucket_idx
  on rate_limit_events (bucket, occurred_at desc);

create table audit_log (
  id bigint generated always as identity primary key,
  user_id uuid references users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  ip_hash text,
  created_at timestamptz not null default now()
);
create index audit_log_user_idx on audit_log (user_id, created_at desc);

create table idempotency_keys (
  user_id uuid not null references users(id) on delete cascade,
  key text not null,
  route text not null,
  response_status int,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (user_id, key, route)
);
```

## 5. Event and outcome model

### 5.1 Transactional event writes

Every task mutation writes the current task row and a `task_events` row in the same transaction. If the event insert fails, the task change rolls back. This is the audit trail and the training data source.

- `actor_user_id` is the signed-in user. For system changes (recurrence materialization, recommendation apply), it is the task owner or `null`.
- `payload` stores a small before/after diff, never the full task.
- Events are append-only. Corrections are new events; rows are never updated or deleted except by account purge.
- Event timestamps are server-generated UTC. Client timestamps are untrusted and stored only in metadata if needed.

### 5.2 Outcome horizons

| Horizon | Observed at | Statuses written |
|---|---|---|
| `24h` | `created_at + 24h` | `pending`, `completed_on_time`, `completed_late` |
| `7d` | `created_at + 7d` | `pending`, `completed_on_time`, `completed_late` |
| `deadline` | `due_at` (skipped when no deadline) | `completed_on_time`, `completed_late`, `overdue`, `deleted_before_due`, `deleted_after_due`, `reopened` |
| `30d` | `max(due_at, created_at) + 30d` | `completed_on_time`, `completed_late`, `abandoned`, `deleted_before_due`, `deleted_after_due`, `reopened` |

Rules:

- A deadline is the exact instant stored in `due_at`. Date-only deadlines compose to `23:59` local time in the UI (existing behavior), so the stored instant is unambiguous.
- `completed_on_time` means `completed_at <= due_at`. For tasks without a deadline, it means `completed_at <= created_at + 7d`.
- `completed_late` means completed after the deadline (or after the 7-day no-deadline window).
- `overdue` means still open at the deadline horizon.
- `abandoned` means still open at the 30-day horizon with no completion and no activity for 30 days.
- `deleted_before_due` / `deleted_after_due` compare `deleted_at` with `due_at` (or the 7-day window when no deadline).
- `reopened` means the task was completed and later reopened. The outcome row's `revision` increments and `metadata.reopenedAt` records the time.
- The resolver is idempotent: it upserts by `(task_id, horizon)`, increments `revision` only when the status actually changes, and never moves `observed_at`.

### 5.3 Prediction labels

Each stored prediction is evaluated against the task's outcome:

| Situation | Label |
|---|---|
| Completed on time | `1` |
| Completed late | `0` |
| Overdue at deadline | `0` |
| Abandoned | `0` |
| Deleted before completion | `0` |
| Reopened within 7 days of completion | `0` for the original prediction |
| Reopened after 7 days | Original label stays `1`; metadata `reopened_later: true`; a new prediction is made |
| Still pending before the horizon | no `prediction_outcomes` row yet |

`prediction_outcomes` is written once per prediction when its label is determined. It stores the label, the outcome status, and metadata such as `backfilled`.

### 5.4 Reopen and delete behavior

- **Reopen:** append `task.reopened`, clear `completed_at`, set `done = false`, create a fresh prediction, and revise the `deadline`/`30d` outcome rows to `reopened`. If the reopen is within 7 days, relabel the original prediction as `0`; otherwise keep `1` and record `reopened_later`.
- **Delete:** soft delete (`deleted_at`), append `task.deleted`, and resolve the next outcome as `deleted_before_due` or `deleted_after_due`. A restore clears `deleted_at`, appends `task.restored`, and allows future outcomes to be revised.
- **Clear completed:** soft-delete each completed task through the same path so events and outcomes stay consistent.

### 5.5 Backfill

Existing JSON tasks have no event history or predictions. The migration synthesizes:

- `task.created` at `createdAt`.
- `task.completed` at `completedAt` when done.
- `task.milestone_added` for each milestone.
- `task_outcomes` for completed tasks, with `metadata.backfilled = true`.

Backfilled outcomes are excluded from calibration and may be used as weak cold-start priors (weight 0.5) after 30 days. No backfilled prediction is shown as a real historical prediction.

---

## 6. Prediction model v2

### 6.1 Definitions

- `now` — current server time, UTC.
- `L` — lead time in days: `max(0.01, (due_at - now) / 86_400_000)`. When scoring a past task, use `(due_at - created_at)`.
- `D` — completion duration in days: `(completed_at - created_at) / 86_400_000`.
- `w_i` — recency weight: `0.5 ** (age_days_i / 90)`. The half-life is 90 days by default and stored per model version.
- `n_eff` — effective sample count: sum of weights.

### 6.2 Personal history buckets

The model uses four levels, from most specific to broadest:

| Level | Bucket | Minimum effective sample |
|---|---|---|
| B3 | Similar text within the same category | 5 |
| B2 | Category × priority | 5 |
| B1 | All of the user's completed tasks | 5 |
| B0 | Global prior (benchmark + opted-in aggregate state) | always available |

Text similarity:

- Normalize to lowercase, Unicode-aware tokenization, strip punctuation, and remove common stopwords plus task filler words (`the`, `a`, `to`, `for`, `and`, `my`, `please`).
- Compute Jaccard similarity over token sets. A score ≥ 0.55 is a strong similar task; ≥ 0.35 is a weak match.
- Use the top 20 candidates from the user's completed tasks in the last 24 months, weighted by recency.
- For non-English text, whitespace/Unicode tokenization still works; stemming is intentionally omitted in v1.
- No embeddings in v1. The feature payload stores a text hash and similar task IDs, not raw text.

### 6.3 Hierarchical Beta model (on-time probability)

For each bucket `b`:

```
s_b = Σ w_i * y_i
f_b = Σ w_i * (1 - y_i)
n_b = s_b + f_b
```

The parent posterior is the prior for the child:

```
α_b = k * p_parent
β_b = k * (1 - p_parent)
p_b = (s_b + α_b) / (n_b + α_b + β_b)
```

- `k = 8` is the prior strength.
- B0 uses `α = 2`, `β = 2`, or a benchmark-derived prior when available.
- Select the deepest bucket with `n_eff >= 5`. If `2 <= n_eff < 5`, blend the bucket with its parent:

```
p = (n_eff * p_b + k * p_parent) / (n_eff + k)
```

- If no bucket has data, use B0 and mark confidence `low`.

This is empirical-Bayes smoothing: a user with two late temple tasks does not get a 100% late prediction, and a new user inherits the population prior.

### 6.4 Log-normal duration model

For completed tasks, model log-duration:

```
x_i = ln(max(D_i, 0.25))
```

For each bucket, compute weighted mean `μ_b` and variance `σ_b²`, then shrink toward the parent:

```
μ = (n_eff * μ_b + k * μ_parent) / (n_eff + k)
σ² = (n_eff * σ_b² + k * σ_parent²) / (n_eff + k)
```

Clamp `σ` to `[0.25, 1.5]` to prevent overconfidence.

Deadline probability:

```
p_duration = Φ((ln L - μ) / σ)
```

Expected completion dates:

```
P50 = now + exp(μ) days
P80 = now + exp(μ + 0.8416 * σ) days
```

No-deadline probability of finishing within 7 days:

```
p_7d = Φ((ln 7 - μ) / σ)
```

Cold start:

- Use the benchmark median/P85 for the category × priority if available.
- Otherwise use `μ = ln(7)`, `σ = 0.8`.
- Mark `mode: "global"` and confidence `low` until the user has 5 outcomes.

### 6.5 Blending

Blend the duration model and the Beta on-time model in logit space:

```
logit(p_raw) = w * logit(p_duration) + (1 - w) * logit(p_ontime)
w = clamp(n_duration / (n_duration + n_ontime), 0.3, 0.7)
```

- If one side has no data, use the other.
- If neither has data, use the global prior.
- Clamp `p_raw` to `[0.01, 0.99]` before calibration.

### 6.6 Per-user calibration

Raw probabilities are often miscalibrated. Fit Platt scaling per user:

```
p_cal = sigmoid(a * logit(p_raw) + b)
```

- Fit when the user has at least 50 labeled predictions; before that, use the global calibration.
- Weight training examples by the same 90-day decay.
- Regularize toward `a = 1`, `b = 0` with L2; clamp `a` to `[0.2, 3]` and `b` to `[-2, 2]`.
- Use Newton-Raphson or a small number of gradient steps; store `a` and `b` in `user_model_state`.
- Re-fit nightly, not on every request.
- Backtest on a time-ordered split: train on older outcomes, evaluate on newer ones. Do not random-split time series.

### 6.7 Confidence and intervals

- Compute an 80% interval from the Beta posterior or a normal approximation on the logit scale; store `p_low` and `p_high`.
- Confidence:
  - `low`: `n_eff < 5` or interval width > 0.40.
  - `medium`: `5 <= n_eff < 20`.
  - `high`: `n_eff >= 20` and interval width <= 0.25.
- Also downgrade confidence when calibration has fewer than 20 labeled outcomes.
- The UI always shows the interval or a "still learning" label; never a bare percentage with no context.

### 6.8 Reasons and evidence

Generate at most three reasons from the strongest feature contributions:

1. Lead time vs. the user's median/P80 duration.
2. Similar-task outcomes (count, on-time rate, typical duration).
3. Weekday/time pattern (e.g., weekend mornings).
4. Priority/category tendency.
5. Current workload (open tasks due in the next 7 days).
6. Deadline shift count (rescheduled tasks are riskier).

Evidence contains up to three similar tasks: task ID, similarity, outcome, and duration. The UI joins the task text at render time, scoped to the owner. No other user's text is ever returned.

### 6.9 Snapshot policy

Create a prediction snapshot when:

- A task is created.
- Deadline, priority, or category changes.
- A recommendation is applied.
- A task is reopened.
- `GET /api/tasks/:id/time-machine` finds the latest snapshot older than 15 minutes (rate-limited to one recompute per task per minute).
- A daily job refreshes open tasks due within 14 days or created within 30 days, at most once per task per day.

Always insert a new row and set `superseded_at` on the previous row. Never update a prediction's probability in place.

### 6.10 Model versioning and performance

- Initial version: `tm-v2.0.0`.
- Every prediction stores `model_version`, `features`, `sample_size`, and `confidence`.
- Cache per-user bucket statistics in `user_model_state.stats`; update incrementally when an outcome resolves.
- Candidate retrieval uses the last 500 completed tasks per user; p95 target is under 300 ms for 1,000 tasks.
- Pure model functions live in `server/services/time-machine/model.ts` and are unit-tested without a database.

### 6.11 Worked example

A user has four "go to temple" tasks, all completed in 1–2 days, on Sundays. The user adds "Go to temple" with a deadline tomorrow.

- B3: 4 similar tasks, all on time, `n_eff ≈ 3.6` after decay → blend with B2.
- Duration model: `μ ≈ ln(1.5)`, `σ ≈ 0.4`; `L = 1` → `p_duration ≈ 0.35`.
- Beta on-time model: `p_ontime ≈ 0.55` after smoothing.
- Blended `p_raw ≈ 0.44`; calibration keeps it near 0.44; confidence `medium`.
- Recommendation: move the deadline to Sunday, `L = 4` → `p_duration ≈ 0.93`, blended/calibrated to `0.78`; lift `+34` points. The card says "Estimated from 4 similar tasks."

## 7. Recommendation engine

### 7.1 Candidate actions

Every candidate is something the app can actually represent and apply. No free-text advice without a structured action.

#### A. Deadline change

Candidate deadlines:

- The user's P50, P80, and P90 completion dates from the duration model.
- The next three best completion weekdays for this user.
- Current deadline + 1, + 3, and + 7 days.
- The next weekend if weekend completion is materially higher.

Round to the user's preferred completion hour (default 19:00 local), require at least 1 day in the future, and cap at 60 days out.

Score with the same duration model using `L' = (candidate - now) / day`, then calibrate. Rank by lift minus a small delay penalty:

```
score = p_rec - 0.002 * delay_days
```

Only recommend a deadline if `p_rec - p_base >= 0.05` and `p_rec >= 0.50`.

#### B. Schedule window

Find the user's best two-hour work windows by weighted on-time/completion rate across weekday and time-of-day buckets. Require at least 5 historical tasks in the bucket; otherwise shrink toward the user's overall pattern.

Set `scheduled_start_at` to the next occurrence of the best window before the deadline. Effective lead time becomes:

```
L_eff = (due_at - scheduled_start_at) / day + expected_work_days
```

Estimate the window effect from personal history:

```
δ_window = (on_time_rate_in_window - on_time_rate_other) * n / (n + 20)
δ_window = clamp(δ_window, -0.20, 0.20)
p_rec = clamp(p_base + δ_window, 0.01, 0.99)
```

If there is no window data, show the suggestion as structural ("try a Sunday morning block") with no numeric lift.

#### C. Split into subtasks

Trigger when the predicted duration is at least 7 days, or the text contains multiple clauses (commas, "and", "then", semicolons) or multiple action verbs.

Generate 2–4 checkpoints heuristically:

- Split on clauses and conjunctions.
- Use action verbs to name checkpoints ("Draft", "Review", "Publish").
- If no clause structure exists, use generic checkpoints ("Start", "Midpoint", "Finish") with proportional target dates.

Estimate the effect from personal tasks with two or more milestones versus tasks without milestones:

```
δ_split = (on_time_rate_with_milestones - on_time_rate_without) * n / (n + 20)
δ_split = clamp(δ_split, -0.15, 0.15)
p_rec = clamp(p_base + δ_split, 0.01, 0.99)
```

This is observational, so the UI labels it "estimated" and the holdout measures it causally. If there is no data, show the structure without a number.

#### D. Reminder

Candidate times:

- 24 hours before the deadline.
- Two hours before the best schedule window.
- 09:00 local on the deadline day.

v1 supports in-app reminders. Email reminders are Phase 6 and default off. Estimate the effect from tasks with reminders versus without, shrunk like the other effects, capped at ±0.15. If there is no data, show the reminder as a structural suggestion with no numeric lift.

#### E. Recurrence series

Detect after at least three similar tasks at a regular interval:

- Similarity ≥ 0.55 on normalized text.
- Interval coefficient of variation ≤ 0.25.
- Dominant period of 1, 7, 14, or 30 days; weekday/time clustering for weekly series.

Suggest a series with an RFC 5545 subset (`FREQ=WEEKLY;BYDAY=SU`). Auto-create is off by default. The effect estimate compares recurring-series completion rates with one-off tasks, shrunk heavily; if the sample is small, show the suggestion without a numeric lift.

### 7.2 Ranking and display policy

For each candidate:

```
lift = p_rec - p_base
accept_prior = Beta posterior for (type, context) from recommendation_events
expected_value = lift * accept_prior - action_cost
```

- Show the top candidate as the primary recommendation and up to two alternatives.
- Hide recommendations when:
  - The task is done, deleted, or a team task (v1).
  - The user is in the task-level holdout.
  - Baseline probability is already ≥ 0.85.
  - Lift < 0.05 and the suggestion has no structural value.
  - Confidence is low and the action is a numeric deadline change.
  - The user dismissed this type for this task within 7 days.
  - The task has had 3 impressions today.
- Prefer one high-quality recommendation over a list. "No change is likely to help much" is a valid, honest result.
- Copy always shows the baseline and the recommended probability:

```
Current timeline: 34%
Recommended: 71% (+37 points)
Move the deadline to Sunday, Nov 22 at 7:00 PM
Estimated from 6 similar tasks · Medium confidence
[Apply change] [See other options] [Dismiss]
```

- Never say "you will fail", "guaranteed", or "the AI knows". Use "estimated", "likely", and "based on your history".

### 7.3 Causal measurement

Recommendation lift is a claim about what would have happened. Correlation is not enough.

- Assign 10% of eligible tasks to a holdout at creation using a deterministic hash of the task ID. Holdout tasks show the baseline only and receive no recommendations.
- Treatment tasks see recommendations. Both groups have the same outcome resolution and prediction logging.
- Primary metric: on-time completion rate. Secondary: completion time, abandonment, and reopen rate.
- Analyze intention-to-treat: compare everyone assigned to treatment with everyone assigned to control, regardless of whether they accepted.
- Report lift with a 95% confidence interval. Do not claim causality before at least 200 tasks per arm.
- Until then, label the number "estimated lift" and explain that it is based on similar historical tasks.
- Later, use Thompson sampling over recommendation types to improve acceptance, while keeping a fixed 10% holdout for measurement.
- Stratify analysis by task category, priority, and baseline risk so a win in easy tasks does not hide a loss in hard ones.

### 7.4 Event logging

| Event | When | Required metadata |
|---|---|---|
| `shown` | The card is actually rendered in the viewport | `surface`, `position`, `variant` |
| `accepted` | User clicks apply and the server accepts | `expectedVersion`, `payloadHash` |
| `applied` | The task change commits | `before`, `after`, `taskVersion` |
| `dismissed` | User dismisses | `reason`, `cooldownUntil` |
| `expired` | The recommendation passes its expiry | `reason` |
| `superseded` | A newer prediction replaces it | `predictionId` |

- Batch impressions via `POST /api/recommendations/impressions`; dedupe per recommendation per day.
- `apply` validates that the recommendation belongs to the user, is still active, and that the task version matches. Then it applies the payload, appends `recommendation.applied`, marks the recommendation accepted, and creates a fresh prediction in one transaction.
- A stale apply returns `409` with the current task; the UI refreshes and offers the new recommendation.
- Idempotency: the same `Idempotency-Key` returns the original result and does not apply twice.

### 7.5 Guardrails

- No recommendations for team tasks in v1.
- No deadline move that is earlier than the current deadline unless the user explicitly asks to compress the timeline.
- No reminder outside quiet hours (22:00–07:00 local) unless the user chooses.
- No more than one primary recommendation per task per day.
- No recommendation that contradicts a completed task or a task with 100% progress.
- All numeric claims must be reproducible from stored features and model version.

## 8. API contracts

### Conventions

- JSON request/response bodies; `Content-Type: application/json`.
- Authentication is the existing `HttpOnly` session cookie. Every task, team, time-machine, recommendation, and settings route requires a session.
- Errors use `{ "error": "human-readable message", "code": "MACHINE_CODE", "details": ... }`.
- Status codes: `400` validation, `401` unauthenticated, `403` forbidden, `404` not found, `409` version/idempotency conflict, `422` semantically invalid, `429` rate limited, `500` unexpected.
- All timestamps are ISO 8601 UTC strings.
- Task mutations use optimistic concurrency: the task has a `version`; `PATCH` accepts `expectedVersion`. A mismatch returns `409` with the current task.
- `POST` routes that create or apply something accept an `Idempotency-Key` header. The same key returns the original response.
- List endpoints paginate with `?limit=50&cursor=...`; default 50, max 200.
- Feature flags are returned in `meta.features` where relevant so the UI can hide unfinished surfaces.

### Authentication and account

| Method | Path | Body | Result |
|---|---|---|---|
| `POST` | `/api/auth/register` | `{ email, password, inviteCode?, timezone? }` | `201 { user }` |
| `POST` | `/api/auth/login` | `{ email, password }` | `{ user }` |
| `POST` | `/api/auth/logout` | — | `204` |
| `GET` | `/api/auth/me` | — | `{ user }` |
| `POST` | `/api/auth/verify-email` | `{ token }` | `204` |
| `POST` | `/api/auth/resend-verification` | — | `202` |
| `POST` | `/api/auth/forgot-password` | `{ email }` | `202` (always, to avoid enumeration) |
| `POST` | `/api/auth/reset-password` | `{ token, password }` | `204`; revokes all sessions |
| `GET` | `/api/auth/sessions` | — | `{ sessions }` |
| `DELETE` | `/api/auth/sessions/:id` | — | `204` |
| `POST` | `/api/auth/sessions/revoke-all` | — | `204` |

### Tasks and events

| Method | Path | Body / query | Result |
|---|---|---|---|
| `GET` | `/api/tasks` | `?filter=all\|pending\|overdue\|completed&limit=&cursor=` | `{ tasks, nextCursor }` |
| `POST` | `/api/tasks` | `{ text, dueAt?, priority?, category?, assigneeEmail?, clientRequestId? }` | `201 { task, prediction? }` |
| `GET` | `/api/tasks/:id` | — | `{ task }` |
| `PATCH` | `/api/tasks/:id` | `{ text?, done?, dueAt?, priority?, category?, progress?, assigneeEmail?, expectedVersion? }` | `{ task }` |
| `DELETE` | `/api/tasks/:id` | — | `204` (soft delete) |
| `POST` | `/api/tasks/:id/restore` | — | `{ task }` |
| `POST` | `/api/tasks/:id/milestones` | `{ text, progress }` | `201 { task }` |
| `POST` | `/api/tasks/clear-completed` | — | `{ tasks }` |
| `PUT` | `/api/tasks/order` | `{ ids }` | `{ tasks }` |
| `POST` | `/api/tasks/predict` | `{ text, dueAt?, priority?, category?, shiftCount? }` | `{ prediction }` (preview; not persisted) |
| `GET` | `/api/tasks/:id/time-machine` | — | `{ timeMachine }` |
| `GET` | `/api/tasks/:id/events` | `?limit=&cursor=` | `{ events, nextCursor }` |

`GET /api/tasks/:id/time-machine` returns the current baseline, the recommendation set, evidence, and model metadata. It never returns another user's tasks. Team tasks return a baseline-only payload in v1.

### Recommendations

| Method | Path | Body | Result |
|---|---|---|---|
| `POST` | `/api/recommendations/impressions` | `{ ids: string[] }` | `204` (deduped per recommendation/day) |
| `POST` | `/api/recommendations/:id/apply` | `{ expectedVersion }` | `{ task, prediction, recommendation }` |
| `POST` | `/api/recommendations/:id/dismiss` | `{ reason?: "not_useful"\|"too_busy"\|"wrong"\|"other" }` | `204` |
| `GET` | `/api/recommendations/:id` | — | `{ recommendation }` |

`apply` is atomic: validate ownership and status, check task version, apply the payload, append the task event, mark the recommendation accepted, log the recommendation event, and create a fresh prediction in one transaction. Applying a stale recommendation returns `409` and the current task.

### Time Machine insights and outcomes

| Method | Path | Query | Result |
|---|---|---|---|
| `GET` | `/api/time-machine/insights` | `?range=30d\|90d\|365d` | `{ accuracy, calibration, recommendations, patterns, coldStart }` |
| `GET` | `/api/time-machine/outcomes` | `?taskId=` | `{ outcomes }` |

Example `timeMachine` response:

```json
{
  "taskId": "…",
  "generatedAt": "2026-11-15T10:00:00.000Z",
  "model": {
    "version": "tm-v2.0.0",
    "mode": "personal",
    "sampleSize": 42,
    "confidence": "medium"
  },
  "baseline": {
    "completionProbability": 0.34,
    "interval": [0.24, 0.45],
    "deadline": "2026-11-17T18:30:00.000Z",
    "expectedCompletion": {
      "p50": "2026-11-21T18:30:00.000Z",
      "p80": "2026-11-24T18:30:00.000Z"
    },
    "riskLevel": "HIGH",
    "reasons": [
      "Similar tasks took a median of 8 days; this deadline leaves 2.",
      "Your weekend completion rate is 2.4× your weekday rate."
    ],
    "evidence": [
      {
        "taskId": "…",
        "text": "Go to temple",
        "similarity": 0.82,
        "outcome": "completed_late",
        "durationDays": 9
      }
    ]
  },
  "recommendations": [
    {
      "id": "…",
      "type": "deadline_change",
      "label": "Move deadline to Sun, Nov 22, 7:00 PM",
      "payload": { "dueAt": "2026-11-22T13:30:00.000Z" },
      "baselineProbability": 0.34,
      "recommendedProbability": 0.71,
      "lift": 0.37,
      "confidence": "medium",
      "estimated": true,
      "reasons": ["Adds 5 days, covering your P80 completion time."]
    }
  ],
  "holdout": false
}
```

### Settings, series, and reminders

| Method | Path | Body | Result |
|---|---|---|---|
| `GET` | `/api/settings` | — | `{ settings }` |
| `PATCH` | `/api/settings` | `{ timezone?, predictionEnabled?, recommendationsEnabled?, sharedLearningOptIn?, llmOptIn?, recurrenceAutoCreateDefault?, emailRemindersEnabled? }` | `{ settings }` |
| `GET` | `/api/series` | — | `{ series }` |
| `PATCH` | `/api/series/:id` | `{ autoCreate?, status?, rrule?, timezone? }` | `{ series }` |
| `POST` | `/api/series/:id/activate` | — | `{ series }` |
| `POST` | `/api/series/:id/skip` | — | `{ series }` |
| `POST` | `/api/series/:id/end` | — | `{ series }` |
| `GET` | `/api/reminders` | `?status=scheduled` | `{ reminders }` |
| `POST` | `/api/reminders/:id/dismiss` | — | `204` |

### Account export and deletion

| Method | Path | Body | Result |
|---|---|---|---|
| `POST` | `/api/account/export` | — | `202 { jobId }` |
| `GET` | `/api/account/export/:jobId` | — | `202` while running; `200` file when ready |
| `DELETE` | `/api/account` | `{ confirmEmail, password }` | `202` (30-day grace, then purge) |

### Teams

The existing team routes remain unchanged in behavior and continue to be scoped by verified membership. Team tasks are visible to team members; personal tasks never are. Predictions for team tasks are baseline-only in v1.

### Admin CLI

| Command | Purpose |
|---|---|
| `npm run invite:create -- --email x@y.com --uses 1 --days 30` | Create an invite code (printed once). |
| `npm run user:reset-password -- --email x@y.com` | Emergency password reset. |
| `npm run migrate:json -- --dry-run` | Validate the JSON import without writing. |
| `npm run migrate:json -- --apply` | Import JSON data into Postgres/PGlite. |
| `npm run model:backtest -- --user <id>` | Run an offline backtest for one user. |
| `npm run model:promote -- --version tm-v2.0.1` | Promote a shadow model after review. |

### Rate limits

| Bucket | Limit |
|---|---|
| Registration | 5/hour/IP |
| Login | 10/15 min/IP and 5/hour/email |
| Password reset | 3/hour/email |
| Verification resend | 3/hour/user |
| Prediction preview | 60/min/user |
| Recommendation impressions | 300/min/user |
| Export | 3/day/user |
| General API | 600/min/user |

### Security rules

- `SameSite=Lax` cookies; `Secure` in production; `HttpOnly`; `Path=/`.
- Origin/Referer check on every state-changing request. No wildcard CORS.
- If a cross-origin deployment is ever required, use an explicit origin allowlist plus a CSRF token; prefer same-origin.
- Security headers: CSP, HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors 'none'`.
- Body limit 200 KB; string length limits on every field.
- No secrets or stack traces in production responses.

---

## 9. Frontend UX

### Navigation

Use lightweight hash routes to avoid adding a router dependency:

- `#/tasks` — current task list.
- `#/time-machine` — accuracy, calibration, patterns, recommendation performance.
- `#/settings` — privacy, timezone, sessions, export/delete, recurrence defaults.

The header keeps the account email, theme toggle, and a menu for the three views.

### Task creation flow

1. User types a task and optional deadline/priority/category.
2. After a 400 ms debounce, call `POST /api/tasks/predict` for a preview.
3. The preview card shows baseline probability, expected window, confidence, and the top recommendation.
4. On submit, create the task first. Do not block creation on prediction.
5. After creation, fetch `GET /api/tasks/:id/time-machine` and replace the preview with the persisted snapshot.

### Time Machine card

Layout, top to bottom:

1. **Baseline** — large probability, 80% interval, deadline, expected P50/P80 window, confidence badge.
2. **Recommendation** — "Current 34% → Recommended 71% (+37 points)" with the action label.
3. **Why** — two or three short reasons, each tied to a feature or evidence.
4. **Evidence** — up to three similar tasks with similarity and outcome. Never show another user's text.
5. **Actions** — `Apply change`, `See other options`, `Dismiss`.
6. **Learning footer** — "Based on 42 of your tasks" or "Still learning — 5 more outcomes needed."

For no deadline, replace "on-time probability" with "chance of finishing within 7 days" and show the expected completion window.

### Recommendation card

- Type icon and label.
- Baseline → recommended probability, lift in points.
- Confidence badge and "estimated" marker when the sample is small.
- `Apply` and `Dismiss` buttons.
- For structural suggestions without a numeric estimate: "Suggested structure — estimate pending."
- After apply, animate the probability change and show a short confirmation.
- After dismiss, remove the card and respect a 7-day cooldown for that task/type.

### Insights page

- **Accuracy**: resolved predictions, Brier score, log loss, calibration error, comparison with the global baseline.
- **Calibration chart**: predicted vs actual by probability bucket, with sample counts; accessible table fallback.
- **Recommendations**: shown, accepted, dismissed, acceptance rate, realized lift, holdout lift and confidence interval.
- **Patterns**: best weekday/time windows, typical duration by category/priority, recurrence candidates.
- **Cold start**: if fewer than 20 outcomes, show "Time Machine is still learning" and what will unlock.

### Settings page

- **Privacy**
  - Use my history for my predictions (default on).
  - Help improve shared models with anonymized patterns (default off).
  - Use AI to understand/explain my tasks (default off).
  - Auto-create recurring tasks by default (default off; per-series opt-in still required).
- **Time zone** — browser-detected default, editable.
- **Sessions** — list device/user agent, last seen, revoke; revoke all.
- **Export my data** — request, download when ready.
- **Delete my account** — type email and password, 30-day grace explanation.
- **Email reminders** — default off.

### Recurrence UX

1. After 3 similar tasks at a regular interval, show: "Temple visit looks weekly on Sundays. Create a recurring series?"
2. `Create series` opens a confirmation with title, schedule, next date, and an **Auto-create next occurrence** toggle (off by default).
3. The series appears in a "Recurring" section with pause, edit, skip next, and end.
4. Auto-created tasks are labeled "From series" and link back.
5. Skipping advances the next occurrence without creating a task.

### States and copy

- **Cold start:** "Time Machine is still learning. It needs about N more completed tasks before it can make a confident estimate."
- **Low confidence:** show the interval and "This is an early estimate."
- **No recommendation:** "Your current plan looks solid. No change is likely to help much."
- **Holdout:** baseline only; never reveal that the user is in a holdout.
- **Error:** "The Time Machine is unavailable right now. Your task is saved." Retry button.
- **Never:** "You will fail", "guaranteed", "AI knows", or a probability without context.

### Accessibility and mobile

- `aria-live="polite"` for prediction updates.
- Buttons reachable by keyboard; visible focus rings.
- Risk conveyed by text and icon, not color alone.
- Charts have a table fallback.
- At 390 px, cards stack; probability and recommendation remain above the fold.
- Respect `prefers-reduced-motion` for probability animations.

## 10. Background jobs

| Job | Schedule | Work | Idempotency |
|---|---|---|---|
| `outcome-resolver` | Every 15 min | Resolve due 24h/7d/deadline/30d horizons; relabel reopened tasks. | Unique `(task_id, horizon)`; revision increments. |
| `prediction-refresh` | Daily 02:00 UTC | Refresh open tasks due within 14 days or created within 30 days. Max one snapshot/day/task. | Check latest `created_at`. |
| `recurrence-detect` | Daily 03:00 UTC | Analyze 180 days of completed tasks; suggest series at 3+ occurrences. | Unique suggestion per user/title. |
| `series-materialize` | Every 15 min | Create the next occurrence for active `auto_create` series within 7 days. | Unique `(series_id, occurrence_at)`; check existing task. |
| `reminder-dispatch` | Every 5 min | Send in-app/email reminders that are due. | Mark `sent_at` before/after send with retry. |
| `calibrate-models` | Daily 04:00 UTC | Fit Platt scaling for users with 10+ new outcomes. | Compare `last_calibrated_at`. |
| `backtest-and-promote` | Daily 05:00 UTC | Time-split backtest; promote candidate if metrics pass. | `model_versions.status`. |
| `email-outbox` | Every minute | Send pending verification/reset/reminder emails. | `email_outbox.status`. |
| `export-worker` | Every minute | Build account export archives. | Job status. |
| `purge-deleted` | Daily 06:00 UTC | Hard-delete accounts past the 30-day grace period. | `deleted_at`. |
| `shared-learning-sync` | Daily 06:30 UTC | Copy opted-in minimized rows into global training data. | Unique `(user_id, task_id)`. |
| `rate-limit-cleanup` | Hourly | Delete rate-limit rows older than 24 hours. | Time-based. |

### Job runner

- Beta: one in-process runner started with the API.
- Use `pg_try_advisory_lock('time-machine-jobs')` so only one instance runs jobs when scaled.
- On Postgres, claim jobs with `FOR UPDATE SKIP LOCKED`. On PGlite (single connection), run serially.
- Retry with exponential backoff: 1 min, 5 min, 15 min, 1 hour, 6 hours; then `dead`.
- Every job logs start/end, duration, affected rows, and errors.
- Health endpoint reports the last successful run per critical job.

---

## 11. Privacy and consent

### Defaults

| Setting | Default | Notes |
|---|---|---|
| `prediction_enabled` | on | Personal-history predictions. |
| `recommendations_enabled` | on | Recommendations can be disabled separately. |
| `shared_learning_opt_in` | **off** | Cross-user aggregate learning. |
| `llm_opt_in` | **off** | No task text leaves the server. |
| `recurrence_auto_create_default` | **off** | Per-series opt-in still required. |
| `email_reminders_enabled` | **off** | In-app reminders only until enabled. |

### Shared learning rules

- Only rows from users with `shared_learning_opt_in = true`.
- Features are minimized: category, priority, lead-time bucket, weekday bucket, duration bucket, recurrence flag, label. No raw text, email, name, task ID, or user ID in the feature payload.
- k-anonymity: only include a bucket in the global model if it has at least 20 distinct contributing users; suppress rare categories.
- Opting out deletes the user's `shared_training_rows` and schedules a global recalibration. Previously trained aggregate parameters cannot be perfectly un-trained; the privacy policy must say this. Future models will not use the deleted rows.
- The global model stores aggregate statistics, not individual rows.
- An audit entry records consent changes.

### LLM rules (Phase 7)

- Per-user toggle plus a per-request toggle on task creation.
- Send only the task text and structured context needed for the request.
- Redact emails, phone numbers, URLs, and long numeric IDs before sending.
- Use a provider with zero-retention/no-training terms; document the provider and model.
- Log model, token counts, latency, and a prompt hash — never the raw prompt or task text.
- If the LLM is disabled or fails, fall back to rules; never block task creation.
- The LLM may suggest structured fields, subtasks, or explanations. It may not produce the numeric probability or the lift.
- Budget guard: per-user monthly cap and a global monthly cap; fail closed to rules.

### Export and deletion

- Export includes: profile, settings, tasks, milestones, task events, predictions, outcomes, recommendations, series, reminders, and team memberships. It excludes other users' data and secrets.
- Export format: JSON plus CSV for tasks. Delivered as a short-lived download.
- Deletion: soft delete immediately, revoke sessions, cancel jobs, then purge after 30 days. Audit logs are anonymized. Shared-learning rows are deleted immediately.
- Retention: task events and predictions 24 months; rate-limit rows 24 hours; audit logs 12 months; email outbox 90 days; backups 7 days.

### Legal

- Publish a privacy policy and terms of service before public signup.
- Record consent version and timestamp.
- If serving India/EU users, review DPDP Act 2023 / GDPR obligations, data residency, and breach notification.
- Provide a support contact and a deletion/export request path.

---

## 12. Auth hardening

### Current state vs. public launch

| Area | Current | Required |
|---|---|---|
| Password storage | scrypt salt + hash | PHC-style scrypt string; rehash on login when params change |
| Email verification | none | Token, 24h expiry, single use, soft gate |
| Password reset | CLI only | Email token, 1h expiry, session revocation |
| Login rate limit | none | IP + email buckets |
| Session revocation | logout only | Session list, revoke one/all |
| CSRF | SameSite=Lax | SameSite + Origin check |
| Security headers | none | CSP, HSTS, nosniff, referrer policy |
| Account export/delete | none | Self-service, 30-day deletion grace |
| Audit log | none | Auth, consent, export, delete, session events |
| Backups | JSON files | Managed Postgres PITR + daily logical dump |
| Monitoring | console logs | Structured logs, error tracking, job lag, health |

### Implementation rules

- Keep scrypt; store `scrypt$N$r$p$salt$hash` so parameters can evolve. On successful login, rehash if parameters are outdated.
- Use `timingSafeEqual` and a dummy hash for unknown emails.
- Password length 8–200; reject null bytes and whitespace-only passwords. Do not trim passwords.
- Email tokens: 32 random bytes, SHA-256 stored, single use, expiry enforced in the same transaction as use.
- Password reset always returns `202` and never reveals whether the email exists. On success, revoke all sessions and send a notification.
- Email verification soft gate: unverified users can use personal tasks for 7 days, then become read-only until verified. They cannot invite team members or create teams.
- Session cookies: `HttpOnly`, `Secure` in production, `SameSite=Lax`, `Path=/`, 30-day fixed expiry. Limit to 10 active sessions per user; revoke oldest on login.
- Login rotates the session token. Logout revokes only the current session.
- Rate limiting is Postgres-backed so it works across instances. Return `429` with `Retry-After`.
- Origin check: for `POST/PATCH/PUT/DELETE`, require `Origin` or `Referer` to match `APP_ORIGIN`; reject otherwise.
- CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`.
- Add `helmet` and a request ID middleware. Log request ID, user ID (if any), route, status, and duration; never log passwords or tokens.
- Validate all environment variables at boot. Fail closed in production if `DATABASE_URL`, `APP_ORIGIN`, or the email provider is missing.
- Graceful shutdown: stop accepting requests, finish in-flight work, close the DB pool, stop the job runner.
- Migrations run before the new process starts; keep them backward-compatible for one release.

### Launch checklist

- [ ] Email verification and password reset tested end to end.
- [ ] Rate limits verified with a burst test.
- [ ] Session revocation and password-reset revocation verified.
- [ ] Origin check rejects cross-site state changes.
- [ ] Security headers present on HTML and API responses.
- [ ] Export contains all and only the user's data.
- [ ] Deletion purges after the grace period and revokes sessions.
- [ ] Invite-only registration enforced.
- [ ] Backup restore drill completed.
- [ ] Error tracking and job-lag alerts configured.
- [ ] Privacy policy, terms, and support contact published.
- [ ] Load test at 100 concurrent users; p95 within targets.

## 13. Local development and database strategy

### Why PGlite

Docker and `psql` are not installed on the current machine. PGlite is Postgres compiled to WASM, runs in Node, persists to a directory, and supports the SQL used here (JSONB, partial indexes, transactions, identity columns). It gives Postgres semantics locally and in tests without installing a database server.

### Dependencies

- Runtime: `drizzle-orm`, `pg`, `zod`, `helmet`.
- Development/test: `drizzle-kit`, `@electric-sql/pglite`.
- Optional later: `pino` for structured logs, `@sentry/node` for errors.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DB_DRIVER` | `pglite` | `pglite` locally, `postgres` in production |
| `PGLITE_DATA_DIR` | `server/data/pglite` | Local database directory |
| `DATABASE_URL` | — | Postgres connection string |
| `APP_ORIGIN` | `http://localhost:5173` | Origin check and email links |
| `TIME_MACHINE_V2` | `1` | Enable the v2 engine |
| `RECOMMENDATIONS` | `1` | Enable recommendations |
| `RECOMMENDATION_HOLDOUT_RATE` | `0.10` | Causal holdout |
| `RECURRENCE` | `0` | Enable recurrence suggestions |
| `SHARED_LEARNING` | `0` | Enable shared learning |
| `LLM` | `0` | Enable the optional LLM layer |
| `EMAIL_PROVIDER` | `console` | `console` in dev, `resend` in production |

### Layout

```
server/
  db/
    schema.ts          Drizzle table definitions
    client.ts          PGlite/Postgres pool + Drizzle instance
    migrate.ts         Migration runner
    migrations/        Generated SQL
  repositories/
    users.ts
    sessions.ts
    teams.ts
    tasks.ts
    events.ts
    predictions.ts
    recommendations.ts
    outcomes.ts
    settings.ts
    jobs.ts
  services/
    auth.ts
    tasks.ts
    teams.ts
    time-machine/
      features.ts
      model.ts
      calibration.ts
      predict.ts
      recommendations.ts
      outcomes.ts
  jobs/
    runner.ts
    handlers.ts
```

### Scripts

| Script | Purpose |
|---|---|
| `npm run db:generate` | Generate SQL from the Drizzle schema |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Seed a demo user/tasks (development only) |
| `npm run migrate:json` | Import existing JSON data |
| `npm run test:db` | Run repository tests against PGlite |
| `npm run test:postgres` | Run the same tests against `DATABASE_URL` (CI) |

### Tests

- Each test file creates a temporary PGlite directory, runs migrations, and seeds only its own data.
- API tests spawn the server with `DB_DRIVER=pglite` and a temp directory.
- The existing 42 tests must pass against the database before the JSON store is removed.
- A CI job runs the repository and API suites against a real Postgres service when available.
- No test may depend on another test's data or execution order.

### PGlite caveats

- Single connection; no parallel queries. The job runner runs serially locally.
- No extensions (`citext`, `pgcrypto`, `pg_trgm`). Use application UUIDs and token hashing.
- `FOR UPDATE SKIP LOCKED` may be unavailable; detect the driver and use a serial claim path locally.
- Keep SQL portable: no vendor-specific types beyond standard Postgres.

### Production

- Managed Postgres with encryption at rest and automated backups.
- Connection pooling (`pg.Pool`, max 10–20 for beta); statement timeout 5s.
- Run migrations as a release step, not from every app instance.
- Keep the JSON files read-only for 30 days after cutover as a rollback source.

---

## 14. JSON → Postgres migration

### Preconditions

- Freeze writes (maintenance window) or run a final delta import.
- Snapshot `server/data/tasks.json`, `users.json`, `teams.json`, `sessions.json`; record SHA-256 checksums.
- Run `npm run migrate:json -- --dry-run` and review the report.

### Mapping

| JSON | Postgres |
|---|---|
| `users.json` `users[]` | `users`; combine salt/hash into a PHC scrypt string; `created_at` preserved. |
| `sessions.json` | **Not migrated.** Force re-login; sessions are security-sensitive. |
| `teams.json` `teams[]` | `teams` + `team_members`; link `user_id` by normalized email when an account exists. |
| `tasks.json` `tasks[]` | `tasks`; preserve IDs, text, timestamps, due date, progress, priority, category, team, assignee. |
| `milestones[]` | `task_milestones`; preserve IDs and timestamps. |
| — | Synthesize `task.created` at `created_at`, `task.completed` at `completed_at`, and `task.milestone_added` for each milestone. Mark `backfilled: true`. |
| — | Create `task_outcomes` for completed tasks using `completed_at` vs `due_at`; mark `backfilled: true`. |
| — | Create `user_settings` with defaults; timezone `UTC` until the user sets it. |
| — | Create empty `user_model_state`; no predictions are fabricated. |

### Steps

1. Validate every JSON record; reject or quarantine invalid rows with a report.
2. Insert users, then teams, then team members, then tasks, then milestones.
3. Synthesize events and outcomes.
4. Verify counts, IDs, ownership, and checksums against the source.
5. Write a migration report: inserted, skipped, quarantined, warnings.
6. Run smoke tests: login, task list, create/edit/complete, team visibility, isolation.
7. Switch the app to the database driver; keep JSON read-only.

### Rollback

- Stop the app, restore the JSON snapshot and the previous release, and point `DB_DRIVER` back to the JSON store for one release if necessary.
- Do not delete the Postgres database until the beta has run successfully for 30 days.

### Backfill policy

- Backfilled outcomes are flagged and excluded from calibration.
- They may inform cold-start priors with weight 0.5 after 30 days.
- No backfilled prediction is shown as a real historical prediction.

## 15. Phased implementation plan

Estimates are engineering days for one developer, not calendar promises.

| Phase | Scope | Estimate | Exit criteria |
|---|---|---|---|
| **0** | Baseline auth, teams, and v1 prediction | Done | 42/42 tests, typecheck, build, clean tree |
| **1** | Database foundation: PGlite/Postgres, schema, repositories, JSON import, event logging | 3–4 d | Existing 42 tests pass on the DB; migration dry-run matches counts; every mutation writes an event |
| **2** | Prediction v2: features, hierarchical model, calibration, snapshots, Time Machine API and card | 4–5 d | Probabilities monotonic with lead time; cold start labeled; p95 < 300 ms; snapshots stored with model version |
| **3** | Recommendations: deadline, schedule, subtasks, reminders; apply/dismiss/impressions; holdout | 4–5 d | Apply is atomic and idempotent; stale version 409; every impression logged; holdout receives no recommendations |
| **4** | Learning loop: outcome resolver, nightly calibration, backtesting, insights page | 4–6 d | Outcomes resolve on all horizons; calibration improves Brier on synthetic data; model promotion gate and rollback work |
| **5** | Recurrence: detection, series, suggestions, auto-create, per-series controls | 3–4 d | 3 weekly temple tasks produce a suggestion; auto-create off by default; no duplicate occurrences |
| **6** | Public hardening: email verification/reset, invites, rate limits, sessions, export/delete, headers, backups, monitoring | 8–12 d | Launch checklist complete; 100-user load test; backup restore drill |
| **7** | Optional LLM: parsing, subtasks, explanations, consent, redaction, budget | 5–8 d | No external call when disabled; numeric probabilities unchanged; cost within cap |

**Beta-ready after Phase 6. Core Time Machine value is usable after Phase 4.**

### Phase 1 task list

- [ ] Add `drizzle-orm`, `drizzle-kit`, `pg`, `@electric-sql/pglite`, `zod`, `helmet`.
- [ ] Create `server/db/schema.ts` and the first migration.
- [ ] Create `server/db/client.ts` with a PGlite/Postgres switch.
- [ ] Implement repositories for users, sessions, teams, tasks, events, settings, and jobs.
- [ ] Refactor `server/index.ts` to use services/repositories; keep response shapes unchanged.
- [ ] Add `task_events` writes inside the same transaction as task mutations.
- [ ] Write `scripts/migrate-json-to-db.ts` with dry-run and verification.
- [ ] Adapt the existing tests to a temporary PGlite database.
- [ ] Add repository tests for ownership isolation and transaction rollback.
- [ ] Update README and `.env.example`.
- [ ] Commit Phase 1.

### Phase 2 task list

- [ ] Feature builder: text similarity, category/priority buckets, lead time, workload, weekday/time patterns.
- [ ] Hierarchical Beta model with decay.
- [ ] Log-normal duration model and P50/P80 windows.
- [ ] Blend, calibrate, confidence, reasons, evidence.
- [ ] Prediction snapshot policy and `GET /api/tasks/:id/time-machine`.
- [ ] Extend `POST /api/tasks/predict` with v2 fields while keeping legacy aliases.
- [ ] Time Machine card in the task form and task detail.
- [ ] Model unit tests and API isolation tests.

### Phase 3 task list

- [ ] Deadline candidate generator and what-if scoring.
- [ ] Schedule-window generator and effect estimate.
- [ ] Subtask heuristic generator and effect estimate.
- [ ] Reminder candidate generator and in-app reminder table.
- [ ] Ranking, display policy, and holdout assignment.
- [ ] Apply/dismiss/impressions endpoints with idempotency and version checks.
- [ ] Recommendation UI and post-apply refresh.
- [ ] Tests for atomic apply, stale version, holdout, and cooldown.

### Phase 4 task list

- [ ] Outcome resolver for 24h/7d/deadline/30d.
- [ ] Reopen and delete relabeling.
- [ ] Per-user calibration job.
- [ ] Nightly backtest with time-based split.
- [ ] Model version promotion and rollback.
- [ ] Insights API and page.
- [ ] Tests for DST, timezone edges, and idempotent resolution.

### Phase 5 task list

- [ ] Recurrence detection (interval CV, weekday/time clustering, text similarity).
- [ ] Series suggestion UX and activation.
- [ ] Auto-create job with per-series toggle.
- [ ] Skip, pause, edit, end.
- [ ] Tests for duplicates, timezone/DST, and opt-out.

### Phase 6 task list

- [ ] Email verification and password reset.
- [ ] Invite-only registration and CLI.
- [ ] Rate limits and Origin checks.
- [ ] Session list/revoke UI.
- [ ] Export and delete.
- [ ] Security headers and structured logging.
- [ ] Backups, restore drill, monitoring, alerts.
- [ ] Privacy policy, terms, support contact.
- [ ] Load test and launch checklist.

### Phase 7 task list

- [ ] Provider interface with timeout, retry, and budget guard.
- [ ] Task parsing, subtask suggestions, explanations.
- [ ] Redaction and consent checks.
- [ ] Prompt/response logging policy (hash only).
- [ ] Offline evaluation against user corrections.
- [ ] Kill switch and rules-only fallback.

---

## 16. Metrics and guardrails

### Model quality

| Metric | Target | How measured |
|---|---|---|
| Brier score | ≥10% better than the global baseline after 100 outcomes | Resolved `prediction_outcomes` |
| Expected calibration error | ≤0.05 | Reliability bins |
| P80 interval coverage | 0.75–0.85 | Resolved windows |
| AUC | ≥0.70 after 200 outcomes | Time-split backtest |
| Calibration slope | 0.8–1.2 | Platt fit diagnostics |

### Recommendation quality

| Metric | Target | How measured |
|---|---|---|
| Acceptance rate | ≥15% | `recommendation_events` |
| Realized lift vs holdout | >0 with 95% CI after 200 tasks/arm | Treatment vs control |
| Dismissal rate | <30% | `recommendation_events` |
| Time to complete | 15% reduction for accepted recommendations | Task outcomes |
| Overdue rate | 20% relative reduction | Cohort comparison |

### Reliability and privacy

| Metric | Target |
|---|---|
| p95 task list | <150 ms |
| p95 prediction | <300 ms |
| Job lag | <5 min for outcome resolver |
| API error rate | <0.5% |
| Cross-user leakage | 0 in automated tests |
| Export delivery | <5 min |
| Deletion purge | Within 30 days + 24 hours |

### Guardrails

- No recommendation when confidence is low, the task is done/deleted, the task is a team task, or the user is in holdout.
- No causal claim before the holdout has enough samples; label lift "estimated".
- No raw task text in shared-learning rows or LLM logs.
- No LLM call when `llm_opt_in` is false.
- No model promotion without a backtest and a rollback path.
- No probability displayed without a sample-size/confidence context.

---

## 17. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Sparse per-user history | Poor early predictions | Hierarchical priors, cold-start benchmarks, honest confidence, "still learning" UI |
| Overfitting to recent tasks | Unstable predictions | 90-day decay, regularization, minimum sample sizes, backtesting |
| Recommendation confounding | Claimed lift is not causal | 10% task-level holdout, intention-to-treat analysis, no causal copy before significance |
| Privacy leakage | Trust and legal damage | Repository-level user scoping, no raw text in shared rows, k-anonymity, isolation tests |
| JSON migration data loss | Lost tasks/teams | Dry run, checksums, snapshot, rollback, 30-day read-only JSON |
| PGlite/Postgres divergence | Bugs only in production | Portable SQL, repository tests against both, CI Postgres job |
| Timezone/DST errors | Wrong deadlines/reminders | Store UTC, use IANA timezone, test DST boundaries |
| Job duplication | Duplicate recurrence/reminders | Unique constraints, idempotency keys, advisory lock |
| Email deliverability | Users cannot verify/reset | Reputable provider, SPF/DKIM/DMARC, bounce handling |
| LLM cost/latency | Budget and UX damage | Opt-in, caching, budget caps, rules fallback, timeout |
| Scope creep | Nothing ships | Phase gates, feature flags, acceptance criteria |
| Team task semantics | Wrong recommendations | Baseline-only for team tasks in v1 |

---

## 18. Open decisions

These do not block Phase 1. Recommended defaults are in **bold**.

1. **Production host/database:** **Railway (Singapore) with managed Postgres** for the beta, or Render + Neon. Choose before Phase 6.
2. **Email provider:** **Resend** for simplicity and deliverability, or Amazon SES for cost at scale. Choose before Phase 6.
3. **Invite policy:** **Required invite code, one use, 30-day expiry**, generated by CLI. Confirm.
4. **Team predictions:** **Baseline-only in v1**; recommendations for team tasks later. Confirm.
5. **Retention:** **24 months for events/predictions, 30-day deletion grace, 7-day backups.** Confirm.
6. **Legal:** privacy policy/terms and DPDP/GDPR review before public signup. Needed before Phase 6.
7. **LLM budget/provider:** defer to Phase 7; set a monthly cap before enabling.
8. **Beta size:** start with 20–50 invited users to accumulate outcomes before opening more invites.

---

## 19. Definition of done

A phase is done only when:

- [ ] Typecheck, build, and the full test suite pass.
- [ ] New behavior has automated tests, including authorization/isolation.
- [ ] Database migrations apply cleanly to an empty database and to the previous release.
- [ ] Feature flags default safely and can be rolled back.
- [ ] No secrets, tokens, or raw personal text are logged.
- [ ] README/docs are updated.
- [ ] The work is committed with a descriptive message.
- [ ] The acceptance criteria for that phase are met.

The overall Time Machine v2 is done when a real user can add a task, see a calibrated baseline and a recommendation with lift, apply the recommendation, have the outcome resolved automatically, and see their model improve — with privacy controls and without any cross-user leakage.






