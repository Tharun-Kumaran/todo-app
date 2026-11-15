# To-Do

A to-do app built with **React + Vite + TypeScript**, backed by an **Express**
API that stores accounts, sessions, teams, and tasks in **Postgres** (an
embedded PGlite database locally). Each email/password account has its own
private task list.

## Stack

- React 19 + TypeScript
- Vite (dev server, HMR, production build)
- Express 5 API
- Postgres via `pg` in production, embedded PGlite for local development

## Getting started

Requires Node.js 20.19+ or 22.12+ (Node 22 LTS recommended).

```sh
npm install
npm run dev
```

- UI: http://localhost:5173
- API: http://localhost:3001

The Vite dev server proxies `/api` to the Express server, so the frontend uses
same-origin URLs in development.

## Scripts

| Script              | What it does                                      |
| ------------------- | ------------------------------------------------- |
| `npm run dev`       | Runs the API and Vite together (HMR)              |
| `npm run dev:api`   | Runs only the API with `tsx watch`                |
| `npm run dev:web`   | Runs only Vite                                    |
| `npm run typecheck` | Type-checks the frontend and server (`tsc`)       |
| `npm run build`     | Type-checks, then builds the frontend into `dist` |
| `npm test`          | Runs the suites against an already-running API     |
| `npm run test:db`   | Starts a throwaway PGlite API, runs the suites, cleans up |
| `npm run migrate:json` | Imports legacy JSON data (`--dry-run` / `--apply` / `--verify`) |
| `npm run db:check`  | Connects with the configured driver and prints the server version |
| `npm run state:import` | Imports local Time Machine and invite JSON into Postgres |
| `npm start`         | Runs the API and serves the built UI on `:3001`   |
| `npm run preview`   | Serves the Vite build locally                     |
| `npm run invite:create` | Creates an invite code (see below)            |
| `npm run invite:list`   | Lists invite codes without revealing them      |
| `npm run invite:revoke -- <id>` | Revokes an invite code                |

Production locally:

```sh
npm run build
npm start
# http://localhost:3001
```

## Data

Accounts, sessions, teams, tasks, settings, email state, and outcomes live in
Postgres. Local development uses an embedded [PGlite](https://pglite.dev/)
database at `server/data/pglite/` (git-ignored). Set `DB_DRIVER=postgres` and
`DATABASE_URL` to use a Postgres server instead.

| Table               | Contents                                              |
| ------------------- | ----------------------------------------------------- |
| `users`, `user_settings` | Accounts (scrypt PHC hashes) and per-user preferences |
| `sessions`          | Session token hashes with expiry                      |
| `email_tokens`      | Hashed one-time verification and reset tokens         |
| `teams`, `team_members` | Teams, owners, and invited members                |
| `tasks`, `task_milestones` | Tasks with deadlines, progress, and milestone comments |
| `task_events`       | Append-only audit trail used by Time Machine          |
| `task_outcomes`     | Completion outcomes used to calibrate predictions     |
| `jobs`, `email_outbox` | Background maintenance jobs and outbound email log |
| `app_state`         | Time Machine state and hashed invite codes            |
| `schema_migrations` | Applied migration ids                                 |

Time Machine state (recommendations, outcomes, reminders, series, calibration)
and invite codes live in the `app_state` table when the app runs on Postgres.
Each document is written in one statement, so no persistent disk is required.
Local PGlite development keeps the same documents in `server/data/*.json` for
inspection; mutations are serialized and written with a temp file plus rename.

`npm run state:import` copies those local JSON files into `app_state` (dry run
by default) if you move an existing setup to Postgres.

Each task stores `userId`, `creatorEmail`, `teamId`, `assigneeEmail`, `dueAt`,
`progress`, `completedAt`, `version`, and its milestones. `completedAt` is
stamped when a task becomes complete and cleared when it is reopened. Tasks
created before accounts existed have no `userId`; the first account to register
claims them. Schema changes are applied automatically at server start.

Overrides:

| Variable              | Default                     | Purpose                              |
| --------------------- | --------------------------- | ------------------------------------ |
| `PORT`                | `3001`                      | API/UI port in production            |
| `DB_DRIVER`           | `pglite`                    | `pglite` (embedded) or `postgres`    |
| `PGLITE_DATA_DIR`     | `server/data/pglite`        | PGlite data directory                |
| `DATABASE_URL`        | unset                       | Postgres connection string           |
| `DATABASE_POOL_MAX`   | `15`                        | Postgres pool size                   |
| `DATABASE_SSL`        | unset                       | `require`, `verify`, or `disable` for the Postgres connection |
| `TODO_TIME_MACHINE_FILE` | `server/data/time-machine.json` | Local-only Time Machine file (PGlite mode) |
| `TODO_INVITES_FILE`   | `server/data/invites.json`  | Local-only invite file (PGlite mode) |
| `TODO_INVITE_ONLY`    | unset                       | Set to `1` to require an invite code |
| `TODO_RATE_LIMIT_DISABLED` | unset                  | Set to `1` to disable auth limits    |
| `TODO_PUBLIC_URL`     | request origin              | Base URL used in email links         |
| `RESEND_API_KEY`      | unset                       | Send email through Resend            |
| `TODO_EMAIL_FROM`     | `To-Do <no-reply@example.com>` | From address for outgoing email  |
| `TODO_SESSION_DAYS`   | `30`                        | Session lifetime (1–365 days)        |
| `TODO_COOKIE_SAMESITE`| `lax`                       | Set to `none` for cross-site cookies |
| `TODO_COOKIE_SECURE`  | auto over HTTPS             | Force the `Secure` cookie flag       |
| `TODO_CORS_ORIGIN`    | unset                       | Allow one browser origin with cookies|
| `VITE_API_BASE_URL`   | same-origin `/api`          | API URL for a remote setup           |

`TODO_DATA_FILE`, `TODO_USERS_FILE`, and `TODO_TEAMS_FILE` now only tell the
JSON importer where the legacy files are.

## Migrating from the JSON stores

Older versions stored tasks, accounts, and teams in
`server/data/{tasks,users,teams}.json`. Import them into the database:

```sh
npm run migrate:json -- --dry-run   # report what would be imported (default)
npm run migrate:json -- --apply     # write everything in one transaction
npm run migrate:json -- --verify    # confirm every JSON record is in the database
```

- The import is idempotent; existing rows are skipped, so re-running is safe.
- Records whose ids are not UUIDs are reported and skipped, while valid records
  still import. A summary prints counts plus up to 50 warnings.
- Legacy scrypt password hashes are converted to PHC format, so users keep their
  passwords. Sessions are not imported — users sign in again.
- Backfill synthesizes `task.created`, `task.milestone_added`, and
  `task.completed` events, plus deadline outcomes for completed tasks.
- Back up `server/data/` before running `--apply`.


## Workspaces: Personal vs Team

The application supports distinct workspaces via the sidebar:
- **My Tasks**: Private workspace. Tasks are only visible to and editable by the account owner.
- **Teams**: Shared workspaces created by a host (owner). Members are invited via email and can collaborate on shared tasks, assign tasks to members, set deadlines, and track real-time progress and milestone updates across concurrent browser sessions.

## Authentication

Accounts use email + password. Passwords are salted and hashed with scrypt
(`node:crypto`); plaintext passwords are never stored or returned. Signing in
creates an opaque random session token in an `HttpOnly`, `SameSite=Lax` cookie
(`Secure` over HTTPS). Only a SHA-256 hash of each token is saved, and sessions
expire after 30 days by default.

Every `/api/tasks` route requires a session. Personal tasks are scoped strictly
to the authenticated user. Team tasks are scoped to verified members of that
team.

Email verification and password reset use short-lived, single-use tokens. Only a
SHA-256 hash of each token is stored. Resetting a password revokes every existing
session. Without `RESEND_API_KEY`, messages are written to `email_outbox` and the
server log instead of being delivered; development builds also return the token
so the flow can be tested without a mail server.

Auth hardening in this build:

- Login and registration attempts are rate-limited per IP and per email.
- Cross-origin browser writes are rejected unless the Origin matches the API
  host or `TODO_CORS_ORIGIN`.
- The account menu's **Security** panel lists signed-in devices, lets you
  revoke individual sessions or all other sessions, exports your data as JSON,
  and deletes your account after password confirmation.
- Security headers are set on every response (`nosniff`, `DENY` framing,
  no-referrer, permissions policy, HSTS in production).
- `TODO_INVITE_ONLY=1` turns registration into an invite-only beta.

## Settings and privacy

The **Settings** panel stores per-user preferences in `user_settings`:

- **Personalized predictions** use your own completion history. Turning this off
  falls back to the cold-start baseline and stops recording new labeled
  predictions.
- **Recommendations** control whether Time Machine suggests changes at all.
- **Shared learning** and **AI assistance** are opt-in and off by default. Task
  text is never included in shared learning, and LLM features are deferred until
  the opt-in layer ships.
- **Auto-create recurring tasks** sets the default for new series; each series
  still has its own switch.
- **Email reminders**, time zone, and language tag are stored with the account.

Settings changes take effect on the next request; no restart is needed.

### Invite-only beta

Create a code while the API is running; the server reloads the invite file when
it changes:

```sh
# One use, bound to an email, expires in 30 days.
npm run invite:create -- --email beta@example.com --uses 1 --days 30

# Multi-use, any email, never expires.
npm run invite:create -- --uses 5 --never

npm run invite:list
npm run invite:revoke -- <invite-id>
```

Only a SHA-256 hash of each code is stored. The raw code is printed once. Set
`TODO_INVITE_ONLY=1` on the API before inviting users.

## Time Machine

Each personal task gets a forecast from a hierarchical Beta/log-normal model
using the owner's history, plus up to three ranked recommendations (deadline
change, schedule window, checkpoints, reminder, or a recurring series). The
first recommendation is shown as:

> Current timeline: X%; recommended change: Y% (+lift)

Recommendations are suggestions only. Recurring series start inactive with
auto-create off until the owner opts in. A deterministic 10% holdout receives
baseline forecasts but no recommendations so lift can be measured rather than
assumed. Team tasks get baseline-only estimates until team dependencies are
modeled.

Outcome hooks record on-time, late, overdue, abandoned, reopened, and deleted
states. Per-user calibration is fitted after enough labeled predictions and is
used on subsequent forecasts. The insights endpoint reports Brier score,
calibration error, acceptance rate, and observed patterns.

## Recurring series

Completing the same personal task at least three times on a regular cadence
(daily, weekly, every two weeks, or monthly) creates a series suggestion. Team
tasks are excluded: their history stays baseline-only for Time Machine.

Suggestions are listed in **Recurring series** on the personal task page. They
start inactive and never create tasks until the owner opts in. Each series has
its own controls:

- **Auto-create** is off by default. Turn it on per series and new occurrences
  appear as ordinary tasks labelled **From series**.
- **Pause / Resume** stops and restarts scheduling without losing the series.
- **Skip next** advances past the upcoming occurrence and removes the generated
  task if it is still open.
- **End** stops the series permanently and clears its schedule.

At most one generated task per series is open at a time. Materialization runs
lazily on list requests and is idempotent: a series may create at most one task
per occurrence, and deleted occurrences stay reserved through the
`tasks_series_occurrence_uq` unique index. Series are stored per user in the
Time Machine state (a JSON file locally, `app_state` on Postgres); generated
tasks live in Postgres with their `source = 'recurrence'`, `series_id`, and
`occurrence_at` columns.

## API

All `/api/tasks` and `/api/teams` routes require the session cookie.
Unauthenticated requests get `401`.

| Method   | Path                                  | Body                                                  | Result           |
| -------- | ------------------------------------- | ----------------------------------------------------- | ---------------- |
| `POST`   | `/api/auth/register`                  | `{ email, password }`                                 | `{ user }` (201) |
| `POST`   | `/api/auth/login`                     | `{ email, password }`                                 | `{ user }`       |
| `GET`    | `/api/auth/me`                        | —                                                     | `{ user }`       |
| `POST`   | `/api/auth/logout`                    | —                                                     | 204              |
| `GET`    | `/api/auth/sessions`                  | —                                                     | `{ sessions }`   |
| `DELETE` | `/api/auth/sessions/:id`              | —                                                     | 204              |
| `POST`   | `/api/auth/sessions/revoke-others`    | —                                                     | `{ revoked }`    |
| `POST`   | `/api/auth/email/verification`        | —                                                     | `{ sent }`       |
| `POST`   | `/api/auth/email/verify`              | `{ token }`                                           | `{ user }`       |
| `POST`   | `/api/auth/password/forgot`           | `{ email }`                                           | `{ sent }`       |
| `POST`   | `/api/auth/password/reset`            | `{ token, password }`                                 | 204              |
| `GET`    | `/api/account/export`                 | —                                                     | JSON download    |
| `DELETE` | `/api/account`                        | `{ password }`                                        | 204              |
| `GET`    | `/api/teams`                          | —                                                     | `{ teams }`      |
| `POST`   | `/api/teams`                          | `{ name }`                                            | `{ team }` (201) |
| `GET`    | `/api/teams/:id`                      | —                                                     | `{ team }`       |
| `POST`   | `/api/teams/:id/members`              | `{ email }`                                           | `{ team }` (201) |
| `DELETE` | `/api/teams/:id/members/:email`       | —                                                     | `{ team }`       |
| `GET`    | `/api/tasks(?teamId=...)`             | —                                                     | `{ tasks }`      |
| `GET`    | `/api/tasks/:id`                      | —                                                     | `{ task }`       |
| `POST`   | `/api/tasks`                          | `{ text, dueAt?, teamId?, assigneeEmail? }`           | `{ task }` (201) |
| `PATCH`  | `/api/tasks/:id`                      | `{ text?, done?, dueAt?, progress?, assigneeEmail? }` | `{ task }`       |
| `POST`   | `/api/tasks/:id/milestones`           | `{ text, progress? }`                                 | `{ task }` (201) |
| `DELETE` | `/api/tasks/:id`                      | —                                                     | 204              |
| `POST`   | `/api/tasks/clear-completed(?teamId)` | —                                                     | `{ tasks }`      |
| `PUT`    | `/api/tasks/order(?teamId=...)`       | `{ ids: string[] }`                                   | `{ tasks }`      |
| `POST`   | `/api/tasks/predict`                  | `{ text, dueAt?, priority?, category? }`              | legacy + v2 forecast |
| `GET`    | `/api/tasks/:id/time-machine`         | —                                                     | `{ timeMachine }`|
| `POST`   | `/api/recommendations/:id/apply`      | `{ expectedVersion }`                                 | task + forecast  |
| `POST`   | `/api/recommendations/:id/dismiss`    | `{ reason? }`                                         | 204              |
| `POST`   | `/api/recommendations/impressions`    | `{ ids: string[] }`                                   | 204              |
| `GET`    | `/api/recommendations/:id`            | —                                                     | `{ recommendation }` |
| `GET`    | `/api/time-machine/insights`          | —                                                     | `{ insights }`   |
| `GET`    | `/api/time-machine/outcomes(?taskId)` | —                                                     | `{ outcomes }`   |
| `GET`    | `/api/series`                         | —                                                     | `{ series }`     |
| `POST`   | `/api/series`                         | `{ title, rrule, timezone?, autoCreate? }`            | `{ series }` (201, 409 on duplicate) |
| `PATCH`  | `/api/series/:id`                     | `{ autoCreate?, status? }`                            | `{ series }`     |
| `POST`   | `/api/series/:id/skip`                | —                                                     | `{ series }`     |
| `POST`   | `/api/series/materialize`             | —                                                     | `{ series, tasks }` |
| `GET`    | `/api/settings`                       | —                                                     | `{ settings }`   |
| `PATCH`  | `/api/settings`                       | partial `UserSettings`                                | `{ settings }`   |
| `GET`    | `/api/reminders(?status)`             | —                                                     | `{ reminders }`  |
| `POST`   | `/api/reminders/:id/dismiss`          | —                                                     | 204              |
| `GET`    | `/api/health`                         | —                                                     | `{ ok }`         |
| `GET`    | `/api/ready`                          | —                                                     | `{ ok, database }` (503 when the DB is down) |

## Testing

```bash
# Self-contained: starts the API on a temporary PGlite database, runs every
# suite, then stops the server and deletes the temporary data.
npm run test:db

# Or against an API you already have running:
npm test

# Against a non-default API:
API_BASE=http://localhost:3011 npm test
```

`npm test` covers the task API, teams, prediction engine, Time Machine,
auth hardening, settings, email verification and reset, recurring series,
database foundation, and the JSON importer.
`tests/db-foundation.test.mjs` and `tests/migration.test.mjs` create their own
temporary databases and do not touch your local data.

## Deploying to production

The production image is a single Node process that serves the API and the built
UI from the same origin. Every durable record lives in Postgres, including Time
Machine state and invite codes in `app_state`, so no persistent disk or volume
is needed. TLS terminates at the host or a reverse proxy in front of the
container.

### Option A: Render free web service + Neon Postgres

This is the free-tier path used by `render.yaml`: Render hosts the Docker
container, Neon hosts Postgres. Render's free web services sleep after about 15
minutes without traffic, and Neon's free database autosuspends, so the first
request after a quiet period can take a minute to wake up.

1. Create a free project at [Neon](https://neon.tech), copy the **pooled**
   connection string, and check it locally:

   ```sh
   DB_DRIVER=postgres DATABASE_URL='postgres://...' DATABASE_SSL=require npm run db:check
   ```

2. In Render: **New → Blueprint**, select this repo, and apply `render.yaml`.
3. When prompted, set the `sync: false` values:
   - `DATABASE_URL`: the Neon connection string.
   - `RESEND_API_KEY`: from [Resend](https://resend.com/api-keys). Optional.
   - `TODO_PUBLIC_URL`: `https://<your-service>.onrender.com` (no trailing
     slash). You can set this after Render assigns the URL and let it redeploy.
4. Wait for the deploy to become healthy at `/api/ready`.
5. Create the first invite from the service **Shell**:

   ```sh
   npm run invite:create -- --email you@example.com --uses 1 --days 30
   ```

   Registration stays invite-only (`TODO_INVITE_ONLY=1`). To open sign-ups
   later, change that env var to `0` and redeploy. Keep it on for the beta.

Resend's test sender (`onboarding@resend.dev`) only delivers to the email
address on your Resend account. Other beta users can still register and use the
app, but their verification and password-reset messages will not arrive until
you verify a domain and update `TODO_EMAIL_FROM`. Without `RESEND_API_KEY` the
service still runs and logs those links to `email_outbox`.

### Option B: any Docker host + managed Postgres

Works with Fly.io, Railway, a VPS, or any container platform. Use Neon,
Supabase, or the host's Postgres for the database. Check the connection string
from your machine first:

```sh
DB_DRIVER=postgres \
DATABASE_URL='postgres://user:pass@host:5432/todo' \
DATABASE_SSL=require \
npm run db:check
```

Then build and run the image:

```sh
docker build -t todo-app .
docker run -p 3001:3001 \
  -e NODE_ENV=production \
  -e DB_DRIVER=postgres \
  -e DATABASE_URL='postgres://user:pass@host:5432/todo' \
  -e DATABASE_SSL=require \
  -e TODO_PUBLIC_URL='https://todo.example.com' \
  -e TODO_INVITE_ONLY=1 \
  -e RESEND_API_KEY='re_...' \
  -e TODO_EMAIL_FROM='To-Do <no-reply@example.com>' \
  todo-app
```

Point the platform's health check at `/api/ready` (checks the database) or
`/api/health` (process only), and terminate TLS in front of port 3001. The app
trusts one proxy hop (`trust proxy`) and enables HSTS when `NODE_ENV=production`,
so cookies are `Secure` behind HTTPS.

Required production settings:

| Variable | Notes |
| -------- | ----- |
| `DB_DRIVER=postgres` | Do not run production on PGlite. |
| `DATABASE_URL` | Managed Postgres connection string. |
| `DATABASE_SSL` | `require` for Render/Neon/Supabase; `verify` only if the CA is trusted. |
| `TODO_PUBLIC_URL` | Public origin; otherwise email links use the request origin. |
| `TODO_INVITE_ONLY=1` | Invite-only beta. |
| `RESEND_API_KEY`, `TODO_EMAIL_FROM` | Real email delivery. Optional, but required for self-serve sign-up. |

`TODO_TIME_MACHINE_FILE` and `TODO_INVITES_FILE` only apply to local PGlite
mode. On Postgres, both stores use `app_state` and need no extra configuration.

Migrations run automatically at startup and are idempotent, so deploying a new
image is enough to apply schema changes. Seed a new database by letting the
service start once; there is no separate migration command.

### Post-deploy smoke test

```sh
curl -fsS https://your-host/api/health   # {"ok":true}
curl -fsS https://your-host/api/ready    # {"ok":true,"database":"postgres"}
```

Then in the browser: register with an invite you created from the shell, add a
task, mark it complete, reload, and confirm it persisted. Create a recurring
series and confirm it survives a redeploy. Sign in on a second account and
confirm tasks are private.

### Backups and restore

- **Postgres** is the source of truth for accounts, tasks, Time Machine state,
  and invite hashes. Use the provider's backups (Neon has restore and branching),
  or `pg_dump "$DATABASE_URL" > todo.sql` on a schedule. Restore with
  `psql "$DATABASE_URL" < todo.sql` before starting the service.
- **Invite codes** cannot be recovered (only hashes are stored). Keep raw codes
  somewhere safe; otherwise revoke and reissue one.
- Run a single app instance for the beta. Time Machine state is written as one
  JSON document per update, so concurrent writes from multiple instances could
  overwrite each other.

### Continuous integration

`.github/workflows/ci.yml` installs dependencies, runs `npm run build`
(type-check + Vite build), and runs `npm run test:db` against a throwaway
PGlite database on every push and pull request.

### GitHub Pages (frontend only)

`.github/workflows/deploy-pages.yml` still publishes `dist` to GitHub Pages on
every push to `main`. Pages only serves static files, so it is useful as a
preview, not as the production deployment.

For a split frontend/API setup, set `VITE_API_BASE_URL` to the API URL at build
time, set `TODO_CORS_ORIGIN` to the Pages origin, and use
`TODO_COOKIE_SAMESITE=none` with an HTTPS API so the cross-site cookie is
accepted. The single-origin Docker deployment above avoids all of that.

## Features

- Email + password accounts with salted scrypt hashes, `HttpOnly` session
  cookies, email verification, and single-use password reset links
- Private per-user task lists, with the signed-in email and sign-out in the
  header
- Settings for time zone, language, prediction and recommendation privacy,
  shared-learning and AI opt-ins, reminder email, and recurring-task defaults
- A Time Machine insights view with calibration score, Brier score, acceptance
  rate, and detected scheduling patterns
- Add, complete, edit (double-click), and delete tasks
- Optional deadline (date + time) when creating a task, shown as a relative
  badge (overdue / due today / due tomorrow / date)
- Granular progress from 0–100% per task, with 100% marking the task complete
- Timestamped progress updates ("milestones") that record a comment together
  with the completion percentage at that moment
- Deadline editing and clearing from the task's details panel
- All / Pending / Overdue / Completed filters with live counts and an overall
  progress bar. Pending includes overdue tasks; Overdue means a task with a
  past deadline that is not yet complete
- Every task (including completed and overdue ones) keeps its full detail
  panel: progress, deadline, progress updates, and created / last updated /
  completed timestamps
- Drag to reorder in the All view
- Recurring-series detection from three or more regular completions, with
  per-series opt-in auto-create, pause/resume, skip, and end controls
- Light/dark theme, following the system by default
- `/` focuses the new-task input
- Server-side validation, idempotent migrations, and durable state (JSON files
  locally, Postgres in production)
