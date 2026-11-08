# To-Do

A to-do app built with **React + Vite + TypeScript**, backed by an **Express**
API that persists tasks to a local JSON file.

## Stack

- React 19 + TypeScript
- Vite (dev server, HMR, production build)
- Express 5 API
- Atomic JSON file storage (`server/data/tasks.json`)

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

Tasks live in `server/data/tasks.json`. The file is created on first run and is
git-ignored because it contains your personal list. Writes go through a temp
file and an atomic rename, and mutations are serialized to avoid lost updates.

Overrides:

| Variable         | Default                     | Purpose                    |
| ---------------- | --------------------------- | -------------------------- |
| `PORT`           | `3001`                      | API/UI port in production  |
| `TODO_DATA_FILE` | `server/data/tasks.json`    | Location of the JSON store |
| `VITE_API_BASE_URL` | same-origin `/api`      | API URL for a remote setup |

## API

| Method   | Path                         | Body                    | Result              |
| -------- | ---------------------------- | ----------------------- | ------------------- |
| `GET`    | `/api/tasks`                 | —                       | `{ tasks }`         |
| `POST`   | `/api/tasks`                 | `{ text }`              | `{ task }` (201)    |
| `PATCH`  | `/api/tasks/:id`             | `{ text?, done? }`      | `{ task }`          |
| `DELETE` | `/api/tasks/:id`             | —                       | 204                 |
| `POST`   | `/api/tasks/clear-completed` | —                       | `{ tasks }`         |
| `PUT`    | `/api/tasks/order`           | `{ ids: string[] }`     | `{ tasks }`         |
| `GET`    | `/api/health`                | —                       | `{ ok, tasks }`     |

## Deploying the frontend

`.github/workflows/deploy-pages.yml` builds the frontend and publishes `dist`
to GitHub Pages on every push to `main`.

GitHub Pages only serves static files, so the local JSON API is **not**
available there. The deployed page will show a connection error until you host
the Express server elsewhere and set `VITE_API_BASE_URL` to its URL at build
time.

## Features

- Add, complete, edit (double-click), and delete tasks
- All / Active / Done filters with live counts and a progress bar
- Drag to reorder in the All view
- Light/dark theme, following the system by default
- `/` focuses the new-task input
- Server-side validation, serialized writes, and a corrupt-file backup
