# To-Do

A to-do app built with **React + Vite + TypeScript**, backed by an **Express**
API that persists tasks to a local JSON file. Each email/password account has
its own private task list.

## Stack

- React 19 + TypeScript
- Vite (dev server, HMR, production build)
- Express 5 API
- Atomic JSON file storage for tasks, accounts, and sessions (`server/data/`)

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
| `npm start`         | Runs the API and serves the built UI on `:3001`   |
| `npm run preview`   | Serves the Vite build locally                     |

Production locally:

```sh
npm run build
npm start
# http://localhost:3001
```

## Data

Runtime data lives in `server/data/` and is git-ignored because it is personal:

| File            | Contents                                                 |
| --------------- | -------------------------------------------------------- |
| `tasks.json`    | Tasks, each mapped to a `userId` and optional `teamId`   |
| `users.json`    | Accounts: id, email, salt, and scrypt password hash      |
| `sessions.json` | Active sessions as SHA-256 token hashes with expiry      |
| `teams.json`    | Teams: id, name, owner, and members list                 |

Writes go through a temp file and an atomic rename, and mutations are
serialized to avoid lost updates.

Each task stores `userId`, `creatorEmail`, `teamId`, `assigneeEmail`, `dueAt`,
`progress`, `completedAt`, and a `milestones` array. `completedAt` is stamped
when a task becomes complete and cleared when it is reopened. Files written by
older versions are migrated on load: deadlines and completion timestamps
default to `null` (with completed tasks using `updatedAt` as their completion
time), completed tasks to 100%, everything else to 0%, and the milestone list
to empty. Tasks created before accounts existed have no `userId`; the first
account to register claims them.

Overrides:

| Variable              | Default                     | Purpose                              |
| --------------------- | --------------------------- | ------------------------------------ |
| `PORT`                | `3001`                      | API/UI port in production            |
| `TODO_DATA_FILE`      | `server/data/tasks.json`    | Location of the task store           |
| `TODO_USERS_FILE`     | `server/data/users.json`    | Location of the account store        |
| `TODO_SESSIONS_FILE`  | `server/data/sessions.json` | Location of the session store        |
| `TODO_TEAMS_FILE`     | `server/data/teams.json`    | Location of the teams store          |
| `TODO_SESSION_DAYS`   | `30`                        | Session lifetime (1–365 days)        |
| `TODO_COOKIE_SAMESITE`| `lax`                       | Set to `none` for cross-site cookies |
| `TODO_COOKIE_SECURE`  | auto over HTTPS             | Force the `Secure` cookie flag       |
| `TODO_CORS_ORIGIN`    | unset                       | Allow one browser origin with cookies|
| `VITE_API_BASE_URL`   | same-origin `/api`          | API URL for a remote setup           |

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

## API

All `/api/tasks` and `/api/teams` routes require the session cookie.
Unauthenticated requests get `401`.

| Method   | Path                                  | Body                                                  | Result           |
| -------- | ------------------------------------- | ----------------------------------------------------- | ---------------- |
| `POST`   | `/api/auth/register`                  | `{ email, password }`                                 | `{ user }` (201) |
| `POST`   | `/api/auth/login`                     | `{ email, password }`                                 | `{ user }`       |
| `GET`    | `/api/auth/me`                        | —                                                     | `{ user }`       |
| `POST`   | `/api/auth/logout`                    | —                                                     | 204              |
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
| `GET`    | `/api/health`                         | —                                                     | `{ ok }`         |

## Testing

Run the integration and end-to-end test suite:

```bash
npm test
```

## Deploying the frontend

`.github/workflows/deploy-pages.yml` builds the frontend and publishes `dist`
to GitHub Pages on every push to `main`.

GitHub Pages only serves static files, so the local JSON API is **not**
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
