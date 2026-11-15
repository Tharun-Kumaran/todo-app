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

Accounts, sessions, teams, tasks, task events, and outcomes live in Postgres.
Local development uses an embedded [PGlite](https://pglite.dev/) database at
`server/data/pglite/` (git-ignored). Set `DB_DRIVER=postgres` and
`DATABASE_URL` to use a Postgres server instead.

| Table               | Contents                                              |
| ------------------- | ----------------------------------------------------- |
| `users`, `user_settings` | Accounts (scrypt PHC hashes) and per-user preferences |
| `sessions`          | Session token hashes with expiry                      |
| `teams`, `team_members` | Teams, owners, and invited members                |
| `tasks`, `task_milestones` | Tasks with deadlines, progress, and milestone comments |
| `task_events`       | Append-only audit trail used by Time Machine          |
| `task_outcomes`     | Completion outcomes used to calibrate predictions     |
| `schema_migrations` | Applied migration ids                                 |

Two stores stay in JSON because they hold model/operator state rather than user
records: `time-machine.json` (recommendations, outcomes, reminders, series) and
`invites.json` (hashed invite codes). Writes go through a temp file and an
atomic rename, and mutations are serialized to avoid lost updates.

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
| `TODO_TIME_MACHINE_FILE` | `server/data/time-machine.json` | Time Machine records and model state |
| `TODO_INVITES_FILE`   | `server/data/invites.json`  | Invite-code store                    |
| `TODO_INVITE_ONLY`    | unset                       | Set to `1` to require an invite code |
| `TODO_RATE_LIMIT_DISABLED` | unset                  | Set to `1` to disable auth limits    |
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
| `GET`    | `/api/time-machine/insights`          | —                                                     | `{ insights }`   |
| `GET`    | `/api/time-machine/outcomes(?taskId)` | —                                                     | `{ outcomes }`   |
| `GET`    | `/api/series`                         | —                                                     | `{ series }`     |
| `GET`    | `/api/reminders(?status)`             | —                                                     | `{ reminders }`  |
| `GET`    | `/api/health`                         | —                                                     | `{ ok }`         |

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
auth hardening, database foundation, and the JSON importer.
`tests/db-foundation.test.mjs` and `tests/migration.test.mjs` create their own
temporary databases and do not touch your local data.

## Deploying the frontend

`.github/workflows/deploy-pages.yml` builds the frontend and publishes `dist`
to GitHub Pages on every push to `main`.

GitHub Pages only serves static files, so the local API is **not**
available there. The deployed page will show a connection error until you host
the Express server elsewhere and set `VITE_API_BASE_URL` to its URL at build
time. For a cross-origin API, also set `TODO_CORS_ORIGIN` to the Pages origin;
if the cookie must cross sites, set `TODO_COOKIE_SAMESITE=none` and serve the
API over HTTPS so the `Secure` cookie is accepted.

## Features

- Email + password accounts with salted scrypt hashes and `HttpOnly` session
  cookies
- Private per-user task lists, with the signed-in email and sign-out in the
  header
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
- Light/dark theme, following the system by default
- `/` focuses the new-task input
- Server-side validation, serialized writes, and a corrupt-file backup
