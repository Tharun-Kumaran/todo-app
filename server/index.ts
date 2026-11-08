import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { User } from '../shared/types';
import { TaskStore, type TaskPatch } from './store';
import { UserStore, normalizeEmail, passwordProblem } from './users';
import {
  SESSION_COOKIE,
  SessionStore,
  clearSessionCookie,
  readCookie,
  sessionCookie,
  type SameSite,
} from './sessions';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, 'data');
const dataFile = process.env.TODO_DATA_FILE
  ? path.resolve(process.env.TODO_DATA_FILE)
  : path.join(dataDir, 'tasks.json');
const usersFile = process.env.TODO_USERS_FILE
  ? path.resolve(process.env.TODO_USERS_FILE)
  : path.join(dataDir, 'users.json');
const sessionsFile = process.env.TODO_SESSIONS_FILE
  ? path.resolve(process.env.TODO_SESSIONS_FILE)
  : path.join(dataDir, 'sessions.json');

const port = Number(process.env.PORT) || 3001;
const maxTextLength = 500;
const maxMilestoneLength = 1000;
const sessionTtlMs = sessionDays(process.env.TODO_SESSION_DAYS) * 86_400_000;
const cookieSameSite: SameSite =
  process.env.TODO_COOKIE_SAMESITE?.trim().toLowerCase() === 'none'
    ? 'None'
    : 'Lax';
const corsOrigin = process.env.TODO_CORS_ORIGIN?.trim() || null;

const store = new TaskStore(dataFile);
const users = new UserStore(usersFile);
const sessions = new SessionStore(sessionsFile, sessionTtlMs);
await Promise.all([store.init(), users.init(), sessions.init()]);

const app = express();
app.disable('x-powered-by');
// Needed for req.secure / X-Forwarded-Proto when deployed behind a proxy.
app.set('trust proxy', 1);

if (corsOrigin) {
  app.use((req, res, next) => {
    if (req.headers.origin === corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      );
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
}

app.use(express.json({ limit: '200kb' }));

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function readText(value: unknown, max = maxTextLength): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

function parseDueAt(value: unknown): Parsed<string | null | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') {
    return { ok: false, error: '`dueAt` must be an ISO date string or null.' };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: '`dueAt` must be a valid ISO date string or null.' };
  }
  return { ok: true, value: date.toISOString() };
}

function parseProgress(value: unknown): Parsed<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, error: '`progress` must be a number from 0 to 100.' };
  }
  return { ok: true, value: Math.min(100, Math.max(0, Math.round(value))) };
}

function sessionDays(value: string | undefined): number {
  const days = Number(value);
  if (!Number.isFinite(days) || days < 1 || days > 365) return 30;
  return days;
}

function cookieOptions(req: Request) {
  const secure =
    cookieSameSite === 'None' ||
    process.env.TODO_COOKIE_SECURE === '1' ||
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https';
  return { secure, sameSite: cookieSameSite };
}

function sendSession(req: Request, res: Response, token: string): void {
  res.setHeader(
    'Set-Cookie',
    sessionCookie(token, Math.floor(sessionTtlMs / 1000), cookieOptions(req)),
  );
}

const requireUser: RequestHandler = (req, res, next) => {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  const userId = token ? sessions.userIdFor(token) : null;
  const user = userId ? users.findById(userId) : null;

  if (!user) {
    if (token) {
      void sessions.destroy(token);
      res.setHeader('Set-Cookie', clearSessionCookie(cookieOptions(req)));
    }
    res.status(401).json({ error: 'Sign in required.' });
    return;
  }

  res.locals.user = user;
  next();
};

function currentUserId(res: Response): string {
  return (res.locals.user as User).id;
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

// --- Authentication -------------------------------------------------------

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const email = normalizeEmail(body.email);
    if (!email) {
      res.status(400).json({ error: 'Enter a valid email address.' });
      return;
    }

    const password = typeof body.password === 'string' ? body.password : '';
    const problem = passwordProblem(password);
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }

    const isFirstUser = users.count() === 0;
    const user = await users.create(email, password);
    if (!user) {
      res
        .status(409)
        .json({ error: 'An account with this email already exists.' });
      return;
    }

    // Tasks written before accounts existed belong to the very first account.
    if (isFirstUser) await store.claimUnowned(user.id);

    sendSession(req, res, await sessions.create(user.id));
    res.status(201).json({ user });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    const user = await users.authenticate(email, password);
    if (!user) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    sendSession(req, res, await sessions.create(user.id));
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', requireUser, (_req, res) => {
  res.json({ user: res.locals.user });
});

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (token) await sessions.destroy(token);
    res.setHeader('Set-Cookie', clearSessionCookie(cookieOptions(req)));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

// --- Tasks ----------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/tasks', requireUser, (_req, res) => {
  res.json({ tasks: store.listFor(currentUserId(res)) });
});

app.get('/api/tasks/:id', requireUser, (req, res) => {
  const task = store.get(currentUserId(res), routeParam(req, 'id'));
  if (!task) {
    res.status(404).json({ error: 'Task not found.' });
    return;
  }
  res.json({ task });
});

app.post('/api/tasks', requireUser, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { text?: unknown; dueAt?: unknown };
    const text = readText(body.text);
    if (!text) {
      res.status(400).json({ error: 'Task text is required.' });
      return;
    }

    const dueAt = parseDueAt(body.dueAt);
    if (!dueAt.ok) {
      res.status(400).json({ error: dueAt.error });
      return;
    }

    const task = await store.add(
      currentUserId(res),
      text,
      dueAt.value ?? null,
    );
    res.status(201).json({ task });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/tasks/:id', requireUser, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as {
      text?: unknown;
      done?: unknown;
      dueAt?: unknown;
      progress?: unknown;
    };
    const patch: TaskPatch = {};

    if (body.text !== undefined) {
      const text = readText(body.text);
      if (!text) {
        res.status(400).json({ error: 'Task text cannot be empty.' });
        return;
      }
      patch.text = text;
    }

    if (body.done !== undefined) {
      if (typeof body.done !== 'boolean') {
        res.status(400).json({ error: '`done` must be a boolean.' });
        return;
      }
      patch.done = body.done;
    }

    const progress = parseProgress(body.progress);
    if (!progress.ok) {
      res.status(400).json({ error: progress.error });
      return;
    }
    if (progress.value !== undefined) patch.progress = progress.value;

    const dueAt = parseDueAt(body.dueAt);
    if (!dueAt.ok) {
      res.status(400).json({ error: dueAt.error });
      return;
    }
    if (dueAt.value !== undefined) patch.dueAt = dueAt.value;

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'Nothing to update.' });
      return;
    }

    const task = await store.update(
      currentUserId(res),
      routeParam(req, 'id'),
      patch,
    );
    if (!task) {
      res.status(404).json({ error: 'Task not found.' });
      return;
    }
    res.json({ task });
  } catch (error) {
    next(error);
  }
});

app.post('/api/tasks/:id/milestones', requireUser, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { text?: unknown; progress?: unknown };
    const text = readText(body.text, maxMilestoneLength);
    if (!text) {
      res.status(400).json({ error: 'Update text is required.' });
      return;
    }

    const progress = parseProgress(body.progress);
    if (!progress.ok) {
      res.status(400).json({ error: progress.error });
      return;
    }

    const task = await store.addMilestone(
      currentUserId(res),
      routeParam(req, 'id'),
      text,
      progress.value,
    );
    if (!task) {
      res.status(404).json({ error: 'Task not found.' });
      return;
    }
    res.status(201).json({ task });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/tasks/:id', requireUser, async (req, res, next) => {
  try {
    const removed = await store.remove(
      currentUserId(res),
      routeParam(req, 'id'),
    );
    if (!removed) {
      res.status(404).json({ error: 'Task not found.' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/tasks/clear-completed', requireUser, async (_req, res, next) => {
  try {
    res.json({ tasks: await store.clearCompleted(currentUserId(res)) });
  } catch (error) {
    next(error);
  }
});

app.put('/api/tasks/order', requireUser, async (req, res, next) => {
  try {
    const ids = (req.body as { ids?: unknown } | undefined)?.ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      res.status(400).json({ error: '`ids` must be an array of task ids.' });
      return;
    }
    res.json({ tasks: await store.reorder(currentUserId(res), ids) });
  } catch (error) {
    next(error);
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

const distDir = path.join(here, '..', 'dist');

if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET') {
      next();
      return;
    }
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.json({
      name: 'todo-app',
      hint: 'Run "npm run dev" for the UI, or "npm run build" then "npm start".',
    });
  });
}

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Something went wrong on the server.' });
};
app.use(errorHandler);

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
  console.log(`Data files: ${dataFile}, ${usersFile}, ${sessionsFile}`);
  if (existsSync(distDir)) {
    console.log(`Serving built UI from ${distDir}`);
  }
});
