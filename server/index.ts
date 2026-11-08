import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Priority, TaskCategory, User } from '../shared/types';
import { TaskStore, type TaskPatch } from './store';
import { UserStore, normalizeEmail, passwordProblem } from './users';
import { TeamStore } from './teams';
import { predictTaskFeasibility } from './prediction';
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
const teamsFile = process.env.TODO_TEAMS_FILE
  ? path.resolve(process.env.TODO_TEAMS_FILE)
  : path.join(dataDir, 'teams.json');

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
const teams = new TeamStore(teamsFile);
await Promise.all([store.init(), users.init(), sessions.init(), teams.init()]);

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

function parsePriority(value: unknown): Parsed<Priority | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  const valid: Priority[] = ['Low', 'Medium', 'High', 'Urgent'];
  if (typeof value !== 'string' || !valid.includes(value as Priority)) {
    return { ok: false, error: '`priority` must be Low, Medium, High, or Urgent.' };
  }
  return { ok: true, value: value as Priority };
}

function parseCategory(value: unknown): Parsed<TaskCategory | null | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') {
    return { ok: false, error: '`category` must be a string or null.' };
  }
  return { ok: true, value: value as TaskCategory };
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

function currentUser(res: Response): User {
  return res.locals.user as User;
}

function currentUserId(res: Response): string {
  return currentUser(res).id;
}

function currentUserEmail(res: Response): string {
  return currentUser(res).email;
}

function currentUserTeamIds(res: Response): string[] {
  return teams.getUserTeamIds(currentUserId(res), currentUserEmail(res));
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

    // Link account to any existing team invitations
    await teams.linkUser(user.id, user.email);

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

    await teams.linkUser(user.id, user.email);
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

// --- Teams ----------------------------------------------------------------

app.get('/api/teams', requireUser, (_req, res) => {
  res.json({
    teams: teams.listForUser(currentUserId(res), currentUserEmail(res)),
  });
});

app.post('/api/teams', requireUser, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'Team name is required.' });
      return;
    }
    const team = await teams.create(
      currentUserId(res),
      currentUserEmail(res),
      name,
    );
    res.status(201).json({ team });
  } catch (error) {
    next(error);
  }
});

app.get('/api/teams/:id', requireUser, (req, res) => {
  const team = teams.get(
    routeParam(req, 'id'),
    currentUserId(res),
    currentUserEmail(res),
  );
  if (!team) {
    res.status(404).json({ error: 'Team not found.' });
    return;
  }
  res.json({ team });
});

app.post('/api/teams/:id/members', requireUser, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { email?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!email) {
      res.status(400).json({ error: 'Member email is required.' });
      return;
    }

    const targetUser = users.findByEmail(email);
    const result = await teams.addMember(
      routeParam(req, 'id'),
      currentUserId(res),
      currentUserEmail(res),
      email,
      targetUser?.id ?? null,
    );

    if (!result.team) {
      res.status(400).json({ error: result.error || 'Could not add member.' });
      return;
    }
    res.status(201).json({ team: result.team });
  } catch (error) {
    next(error);
  }
});

app.delete(
  '/api/teams/:id/members/:email',
  requireUser,
  async (req, res, next) => {
    try {
      const targetEmail = routeParam(req, 'email');
      const result = await teams.removeMember(
        routeParam(req, 'id'),
        currentUserId(res),
        currentUserEmail(res),
        targetEmail,
      );
      if (!result.team) {
        res
          .status(400)
          .json({ error: result.error || 'Could not remove member.' });
        return;
      }
      res.json({ team: result.team });
    } catch (error) {
      next(error);
    }
  },
);

// --- Tasks ----------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/tasks', requireUser, (req, res) => {
  const teamId =
    typeof req.query.teamId === 'string' && req.query.teamId
      ? req.query.teamId
      : null;
  if (teamId) {
    if (!teams.isMember(teamId, currentUserId(res), currentUserEmail(res))) {
      res.status(403).json({ error: 'Not a member of this team.' });
      return;
    }
    res.json({ tasks: store.listFor(currentUserId(res), teamId) });
    return;
  }
  res.json({ tasks: store.listFor(currentUserId(res), null) });
});

app.get('/api/tasks/:id', requireUser, (req, res) => {
  const task = store.get(
    currentUserId(res),
    routeParam(req, 'id'),
    currentUserTeamIds(res),
  );
  if (!task) {
    res.status(404).json({ error: 'Task not found.' });
    return;
  }
  res.json({ task });
});

app.post('/api/tasks', requireUser, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as {
      text?: unknown;
      dueAt?: unknown;
      teamId?: unknown;
      assigneeEmail?: unknown;
      priority?: unknown;
      category?: unknown;
    };
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

    const teamId =
      typeof body.teamId === 'string' && body.teamId ? body.teamId : null;
    if (
      teamId &&
      !teams.isMember(teamId, currentUserId(res), currentUserEmail(res))
    ) {
      res.status(403).json({ error: 'Not a member of this team.' });
      return;
    }

    const assigneeEmail =
      typeof body.assigneeEmail === 'string' && body.assigneeEmail.trim()
        ? body.assigneeEmail.trim().toLowerCase()
        : null;

    const priority = parsePriority(body.priority);
    if (!priority.ok) {
      res.status(400).json({ error: priority.error });
      return;
    }

    const category = parseCategory(body.category);
    if (!category.ok) {
      res.status(400).json({ error: category.error });
      return;
    }

    const task = await store.add(
      currentUserId(res),
      currentUserEmail(res),
      text,
      dueAt.value ?? null,
      teamId,
      assigneeEmail,
      priority.value,
      category.value,
    );
    res.status(201).json({ task });
  } catch (error) {
    next(error);
  }
});

app.post('/api/tasks/predict', requireUser, (req, res) => {
  const body = (req.body ?? {}) as {
    text?: unknown;
    dueAt?: unknown;
    priority?: unknown;
    category?: unknown;
    shiftCount?: unknown;
  };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const dueAt =
    typeof body.dueAt === 'string' && body.dueAt.trim() ? body.dueAt.trim() : null;
  const priority =
    typeof body.priority === 'string' ? (body.priority as Priority) : undefined;
  const category =
    typeof body.category === 'string' ? (body.category as TaskCategory) : undefined;
  const shiftCount = typeof body.shiftCount === 'number' ? body.shiftCount : 0;

  const prediction = predictTaskFeasibility({
    text,
    dueAt,
    priority,
    category,
    shiftCount,
  });

  res.json({ prediction });
});

app.patch('/api/tasks/:id', requireUser, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as {
      text?: unknown;
      done?: unknown;
      dueAt?: unknown;
      priority?: unknown;
      category?: unknown;
      progress?: unknown;
      assigneeEmail?: unknown;
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

    if (body.priority !== undefined) {
      const priority = parsePriority(body.priority);
      if (!priority.ok) {
        res.status(400).json({ error: priority.error });
        return;
      }
      patch.priority = priority.value;
    }

    if (body.category !== undefined) {
      const category = parseCategory(body.category);
      if (!category.ok) {
        res.status(400).json({ error: category.error });
        return;
      }
      patch.category = category.value;
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

    if (body.assigneeEmail !== undefined) {
      patch.assigneeEmail =
        typeof body.assigneeEmail === 'string' && body.assigneeEmail.trim()
          ? body.assigneeEmail.trim().toLowerCase()
          : null;
    }

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'Nothing to update.' });
      return;
    }

    const task = await store.update(
      currentUserId(res),
      routeParam(req, 'id'),
      currentUserTeamIds(res),
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
      currentUserTeamIds(res),
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
      currentUserTeamIds(res),
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

app.post('/api/tasks/clear-completed', requireUser, async (req, res, next) => {
  try {
    const teamId =
      typeof req.query.teamId === 'string' && req.query.teamId
        ? req.query.teamId
        : null;
    if (
      teamId &&
      !teams.isMember(teamId, currentUserId(res), currentUserEmail(res))
    ) {
      res.status(403).json({ error: 'Not a member of this team.' });
      return;
    }
    res.json({ tasks: await store.clearCompleted(currentUserId(res), teamId) });
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
    const teamId =
      typeof req.query.teamId === 'string' && req.query.teamId
        ? req.query.teamId
        : null;
    if (
      teamId &&
      !teams.isMember(teamId, currentUserId(res), currentUserEmail(res))
    ) {
      res.status(403).json({ error: 'Not a member of this team.' });
      return;
    }
    res.json({ tasks: await store.reorder(currentUserId(res), ids, teamId) });
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
  app.use((_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error && typeof error === 'object' && 'type' in error) {
    if ((error as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ error: 'Payload too large.' });
      return;
    }
  }
  console.error('Unhandled server error:', error);
  res.status(500).json({ error: 'Internal server error.' });
};

app.use(errorHandler);

const server = app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
  console.log(`Data files: ${dataFile}, ${usersFile}, ${sessionsFile}, ${teamsFile}`);
  if (existsSync(distDir)) {
    console.log(`Serving built UI from ${distDir}`);
  }
});

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}; shutting down gracefully.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
