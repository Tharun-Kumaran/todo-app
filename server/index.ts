import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Priority, TaskCategory, User } from '../shared/types';
import { TaskStore, type TaskPatch } from './store';
import { UserStore, normalizeEmail, passwordProblem } from './users';
import { TeamStore } from './teams';
import { InviteStore } from './invites';
import { RateLimiter } from './rateLimit';
import { predictTaskFeasibility } from './prediction';
import { TimeMachineStore } from './timeMachineStore';
import {
  TimeMachineError,
  applyRecommendation,
  dismissRecommendation,
  getInsights,
  getTimeMachineForTask,
  handleTaskDeleted,
  handleTaskUpdate,
  previewTimeMachine,
  recordImpressions,
  recordTaskCreated,
  resolveUserOutcomes,
} from './timeMachineService';
import type { TimeMachineTaskInput } from './timeMachine';
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
const timeMachineFile = process.env.TODO_TIME_MACHINE_FILE
  ? path.resolve(process.env.TODO_TIME_MACHINE_FILE)
  : path.join(dataDir, 'time-machine.json');
const invitesFile = process.env.TODO_INVITES_FILE
  ? path.resolve(process.env.TODO_INVITES_FILE)
  : path.join(dataDir, 'invites.json');

const port = Number(process.env.PORT) || 3001;
const inviteOnly =
  process.env.TODO_INVITE_ONLY === '1' ||
  process.env.TODO_INVITE_ONLY?.toLowerCase() === 'true';
const rateLimitDisabled =
  process.env.TODO_RATE_LIMIT_DISABLED === '1' ||
  process.env.TODO_RATE_LIMIT_DISABLED?.toLowerCase() === 'true';
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
const timeMachineStore = new TimeMachineStore(timeMachineFile);
const invites = new InviteStore(invitesFile);
const rateLimiter = new RateLimiter();
const timeMachineDeps = { tasks: store, timeMachine: timeMachineStore };
await Promise.all([
  store.init(),
  users.init(),
  sessions.init(),
  teams.init(),
  timeMachineStore.init(),
  invites.init(),
]);

const app = express();
app.disable('x-powered-by');
// Needed for req.secure / X-Forwarded-Proto when deployed behind a proxy.
app.set('trust proxy', 1);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
  }
  next();
});

/**
 * Reject cross-site browser writes unless the Origin is this host or the one
 * explicitly configured for a split frontend/API deployment. Requests without
 * an Origin header (CLI, tests, same-origin navigations) are allowed.
 */
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    next();
    return;
  }
  const origin = req.headers.origin;
  if (!origin) {
    next();
    return;
  }
  const host =
    req.get('x-forwarded-host')?.split(',')[0]?.trim() || req.get('host');
  const sameOrigin =
    host !== undefined &&
    (origin === `http://${host}` || origin === `https://${host}`);
  if (sameOrigin || (corsOrigin !== null && origin === corsOrigin)) {
    next();
    return;
  }
  res.status(403).json({ error: 'Cross-origin request blocked.' });
});

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

function parseDateField(
  value: unknown,
  field: string,
): Parsed<string | null | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') {
    return { ok: false, error: `\`${field}\` must be an ISO date string or null.` };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return {
      ok: false,
      error: `\`${field}\` must be a valid ISO date string or null.`,
    };
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
  res.locals.sessionToken = token;
  if (token) void sessions.touch(token);
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

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function requestIpHash(req: Request): string {
  return createHash('sha256').update(clientIp(req)).digest('hex').slice(0, 16);
}

function requestMetadata(req: Request): {
  userAgent: string | null;
  ipHash: string;
} {
  return {
    userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
    ipHash: requestIpHash(req),
  };
}

function currentSessionToken(res: Response): string | null {
  const token = res.locals.sessionToken;
  return typeof token === 'string' ? token : null;
}

function rateLimit(
  _req: Request,
  res: Response,
  checks: Array<{ key: string; limit: number; windowMs: number }>,
): boolean {
  if (rateLimitDisabled) return true;
  let retryAfterMs = 0;
  for (const check of checks) {
    const result = rateLimiter.consume(
      check.key,
      check.limit,
      check.windowMs,
    );
    if (!result.allowed) {
      retryAfterMs = Math.max(retryAfterMs, result.retryAfterMs);
    }
  }
  if (retryAfterMs <= 0) return true;
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.setHeader('Retry-After', String(seconds));
  res.status(429).json({
    error: `Too many attempts. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
    code: 'RATE_LIMITED',
  });
  return false;
}

// --- Authentication -------------------------------------------------------

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as {
      email?: unknown;
      password?: unknown;
      inviteCode?: unknown;
    };
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

    const ip = clientIp(req);
    if (
      !rateLimit(req, res, [
        {
          key: `register:ip:${ip}`,
          limit: 100,
          windowMs: 60 * 60_000,
        },
        {
          key: `register:email:${email}`,
          limit: 10,
          windowMs: 60 * 60_000,
        },
      ])
    ) {
      return;
    }

    if (users.findByEmail(email)) {
      res
        .status(409)
        .json({ error: 'An account with this email already exists.' });
      return;
    }

    const inviteCode =
      typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';
    let consumedInvite = false;
    if (inviteOnly) {
      if (!inviteCode) {
        res.status(403).json({
          error: 'This beta is invite-only. Enter your invite code.',
          code: 'INVITE_REQUIRED',
        });
        return;
      }
      const consumed = await invites.consume(inviteCode, email);
      if (!consumed.ok) {
        const message =
          consumed.reason === 'expired'
            ? 'This invite code has expired.'
            : consumed.reason === 'email_mismatch'
              ? 'This invite code was issued for a different email address.'
              : consumed.reason === 'exhausted'
                ? 'This invite code has already been used.'
                : 'That invite code is not valid.';
        res.status(403).json({ error: message, code: 'INVITE_INVALID' });
        return;
      }
      consumedInvite = true;
    }

    const isFirstUser = users.count() === 0;
    const user = await users.create(email, password);
    if (!user) {
      if (consumedInvite) await invites.release(inviteCode);
      res
        .status(409)
        .json({ error: 'An account with this email already exists.' });
      return;
    }

    // Tasks written before accounts existed belong to the very first account.
    if (isFirstUser) await store.claimUnowned(user.id);

    // Link account to any existing team invitations
    await teams.linkUser(user.id, user.email);

    sendSession(
      req,
      res,
      await sessions.create(user.id, requestMetadata(req)),
    );
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

    if (
      !rateLimit(req, res, [
        {
          key: `login:ip:${clientIp(req)}`,
          limit: 200,
          windowMs: 15 * 60_000,
        },
        {
          key: `login:email:${email}`,
          limit: 30,
          windowMs: 15 * 60_000,
        },
      ])
    ) {
      return;
    }

    const user = await users.authenticate(email, password);
    if (!user) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    await teams.linkUser(user.id, user.email);
    sendSession(
      req,
      res,
      await sessions.create(user.id, requestMetadata(req)),
    );
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

app.get('/api/auth/sessions', requireUser, (_req, res) => {
  res.json({
    sessions: sessions.listForUser(
      currentUserId(res),
      currentSessionToken(res),
    ),
  });
});

app.delete('/api/auth/sessions/:id', requireUser, async (req, res, next) => {
  try {
    const revoked = await sessions.revoke(
      currentUserId(res),
      routeParam(req, 'id'),
    );
    if (!revoked) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post(
  '/api/auth/sessions/revoke-others',
  requireUser,
  async (_req, res, next) => {
    try {
      const token = currentSessionToken(res);
      if (!token) {
        res.status(401).json({ error: 'Sign in required.' });
        return;
      }
      const revoked = await sessions.revokeOthers(currentUserId(res), token);
      res.json({ revoked });
    } catch (error) {
      next(error);
    }
  },
);

app.get('/api/account/export', requireUser, (_req, res) => {
  const userId = currentUserId(res);
  const userEmail = currentUserEmail(res);
  const userTeams = teams.listForUser(userId, userEmail);
  const teamTasks = userTeams.flatMap((team) => store.listFor(userId, team.id));
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="todo-export-${userId}.json"`,
  );
  res.json({
    exportedAt: new Date().toISOString(),
    user: currentUser(res),
    tasks: [...store.listFor(userId, null), ...teamTasks],
    teams: userTeams,
    timeMachine: timeMachineStore.exportForUser(userId),
  });
});

app.delete('/api/account', requireUser, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { password?: unknown };
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) {
      res.status(400).json({ error: 'Enter your password to delete your account.' });
      return;
    }

    const userId = currentUserId(res);
    const userEmail = currentUserEmail(res);
    const verified = await users.authenticate(userEmail, password);
    if (!verified) {
      res.status(401).json({ error: 'Password is incorrect.' });
      return;
    }

    const ownedTeams = teams.ownedBy(userId, userEmail);
    if (ownedTeams.length > 0) {
      res.status(409).json({
        error:
          'Delete or transfer the teams you own before deleting your account.',
        code: 'OWNS_TEAMS',
        teams: ownedTeams.map((team) => ({ id: team.id, name: team.name })),
      });
      return;
    }

    await teams.removeUser(userId, userEmail);
    await store.removePersonalForUser(userId);
    await timeMachineStore.deleteForUser(userId);
    await sessions.destroyAllForUser(userId);
    await users.remove(userId);

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
      scheduledStartAt?: unknown;
      reminderAt?: unknown;
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

    const scheduledStartAt = parseDateField(
      body.scheduledStartAt,
      'scheduledStartAt',
    );
    if (!scheduledStartAt.ok) {
      res.status(400).json({ error: scheduledStartAt.error });
      return;
    }
    const reminderAt = parseDateField(body.reminderAt, 'reminderAt');
    if (!reminderAt.ok) {
      res.status(400).json({ error: reminderAt.error });
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
      scheduledStartAt.value ?? null,
      reminderAt.value ?? null,
    );

    const history = store.listFor(currentUserId(res), null);
    try {
      await recordTaskCreated({
        deps: timeMachineDeps,
        userId: currentUserId(res),
        task,
        history,
      });
    } catch (error) {
      // A prediction failure must never block task creation.
      console.error('Time Machine snapshot failed:', error);
    }

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
    teamId?: unknown;
    teamTask?: unknown;
  };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const dueAt =
    typeof body.dueAt === 'string' && body.dueAt.trim() ? body.dueAt.trim() : null;
  const priority =
    typeof body.priority === 'string' ? (body.priority as Priority) : undefined;
  const category =
    typeof body.category === 'string' ? (body.category as TaskCategory) : undefined;
  const shiftCount = typeof body.shiftCount === 'number' ? body.shiftCount : 0;
  const teamTask =
    body.teamTask === true ||
    (typeof body.teamId === 'string' && body.teamId.length > 0);

  const prediction = predictTaskFeasibility({
    text,
    dueAt,
    priority,
    category,
    shiftCount,
  });

  const now = new Date();
  const draft: TimeMachineTaskInput = {
    text,
    dueAt,
    priority,
    category,
    createdAt: now.toISOString(),
    shiftCount,
  };
  const timeMachine = previewTimeMachine({
    deps: timeMachineDeps,
    userId: currentUserId(res),
    draft,
    history: store.listFor(currentUserId(res), null),
    now,
    teamTask,
  });

  res.json({ prediction, timeMachine });
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
      scheduledStartAt?: unknown;
      reminderAt?: unknown;
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

    const scheduledStartAt = parseDateField(
      body.scheduledStartAt,
      'scheduledStartAt',
    );
    if (!scheduledStartAt.ok) {
      res.status(400).json({ error: scheduledStartAt.error });
      return;
    }
    if (scheduledStartAt.value !== undefined) {
      patch.scheduledStartAt = scheduledStartAt.value;
    }

    const reminderAt = parseDateField(body.reminderAt, 'reminderAt');
    if (!reminderAt.ok) {
      res.status(400).json({ error: reminderAt.error });
      return;
    }
    if (reminderAt.value !== undefined) patch.reminderAt = reminderAt.value;

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'Nothing to update.' });
      return;
    }

    const before = store.get(
      currentUserId(res),
      routeParam(req, 'id'),
      currentUserTeamIds(res),
    );
    if (!before) {
      res.status(404).json({ error: 'Task not found.' });
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

    try {
      await handleTaskUpdate({
        deps: timeMachineDeps,
        userId: currentUserId(res),
        before,
        after: task,
        history: store.listFor(currentUserId(res), null),
      });
    } catch (error) {
      console.error('Time Machine update failed:', error);
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

    const before = store.get(
      currentUserId(res),
      routeParam(req, 'id'),
      currentUserTeamIds(res),
    );
    if (!before) {
      res.status(404).json({ error: 'Task not found.' });
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

    try {
      await handleTaskUpdate({
        deps: timeMachineDeps,
        userId: currentUserId(res),
        before,
        after: task,
        history: store.listFor(currentUserId(res), null),
      });
    } catch (error) {
      console.error('Time Machine milestone update failed:', error);
    }

    res.status(201).json({ task });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/tasks/:id', requireUser, async (req, res, next) => {
  try {
    const task = store.get(
      currentUserId(res),
      routeParam(req, 'id'),
      currentUserTeamIds(res),
    );
    if (!task) {
      res.status(404).json({ error: 'Task not found.' });
      return;
    }

    try {
      await handleTaskDeleted({
        deps: timeMachineDeps,
        userId: currentUserId(res),
        task,
      });
    } catch (error) {
      console.error('Time Machine delete handling failed:', error);
    }

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

    const completed = store
      .listFor(currentUserId(res), teamId)
      .filter((task) => task.done);
    for (const task of completed) {
      try {
        await handleTaskDeleted({
          deps: timeMachineDeps,
          userId: currentUserId(res),
          task,
        });
      } catch (error) {
        console.error('Time Machine clear-completed handling failed:', error);
      }
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

// --- Time Machine ---------------------------------------------------------

app.get('/api/tasks/:id/time-machine', requireUser, async (req, res, next) => {
  try {
    const userId = currentUserId(res);
    const task = store.get(
      userId,
      routeParam(req, 'id'),
      currentUserTeamIds(res),
    );
    if (!task) {
      res.status(404).json({ error: 'Task not found.' });
      return;
    }

    const history = store.listFor(userId, null);
    await resolveUserOutcomes({ deps: timeMachineDeps, userId, tasks: history });
    const timeMachine = await getTimeMachineForTask({
      deps: timeMachineDeps,
      userId,
      task,
      history,
    });
    res.json({ timeMachine });
  } catch (error) {
    next(error);
  }
});

app.post('/api/recommendations/impressions', requireUser, async (req, res, next) => {
  try {
    const ids = (req.body as { ids?: unknown } | undefined)?.ids;
    if (
      !Array.isArray(ids) ||
      ids.length > 50 ||
      !ids.every((id) => typeof id === 'string')
    ) {
      res
        .status(400)
        .json({ error: '`ids` must be an array of up to 50 recommendation ids.' });
      return;
    }
    await recordImpressions({
      deps: timeMachineDeps,
      userId: currentUserId(res),
      ids,
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post(
  '/api/recommendations/:id/apply',
  requireUser,
  async (req, res, next) => {
    try {
      const userId = currentUserId(res);
      const recommendation = timeMachineStore.getRecommendation(
        routeParam(req, 'id'),
      );
      if (!recommendation || recommendation.userId !== userId) {
        res.status(404).json({ error: 'Recommendation not found.' });
        return;
      }

      const task = store.get(
        userId,
        recommendation.taskId,
        currentUserTeamIds(res),
      );
      if (!task) {
        res.status(404).json({ error: 'Task not found.' });
        return;
      }

      const expectedVersionRaw = (req.body as { expectedVersion?: unknown } | undefined)
        ?.expectedVersion;
      if (
        expectedVersionRaw !== undefined &&
        (typeof expectedVersionRaw !== 'number' ||
          !Number.isFinite(expectedVersionRaw))
      ) {
        res.status(400).json({ error: '`expectedVersion` must be a number.' });
        return;
      }

      const result = await applyRecommendation({
        deps: timeMachineDeps,
        userId,
        task,
        userTeamIds: currentUserTeamIds(res),
        recommendationId: routeParam(req, 'id'),
        expectedVersion: expectedVersionRaw,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof TimeMachineError) {
        res.status(error.status).json({
          error: error.message,
          code: error.code,
          details: error.details,
        });
        return;
      }
      next(error);
    }
  },
);

app.post(
  '/api/recommendations/:id/dismiss',
  requireUser,
  async (req, res, next) => {
    try {
      const reason = (req.body as { reason?: unknown } | undefined)?.reason;
      if (
        reason !== undefined &&
        (typeof reason !== 'string' || reason.length > 200)
      ) {
        res.status(400).json({ error: '`reason` must be a short string.' });
        return;
      }
      const record = await dismissRecommendation({
        deps: timeMachineDeps,
        userId: currentUserId(res),
        recommendationId: routeParam(req, 'id'),
        reason: typeof reason === 'string' ? reason : undefined,
      });
      if (!record) {
        res.status(404).json({ error: 'Recommendation not found.' });
        return;
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);

app.get('/api/recommendations/:id', requireUser, (req, res) => {
  const record = timeMachineStore.getRecommendation(routeParam(req, 'id'));
  if (!record || record.userId !== currentUserId(res)) {
    res.status(404).json({ error: 'Recommendation not found.' });
    return;
  }
  res.json({ recommendation: record });
});

app.get('/api/time-machine/insights', requireUser, async (_req, res, next) => {
  try {
    const userId = currentUserId(res);
    const tasks = store.listFor(userId, null);
    const insights = await getInsights({
      deps: timeMachineDeps,
      userId,
      tasks,
    });
    res.json({ insights });
  } catch (error) {
    next(error);
  }
});

app.get('/api/time-machine/outcomes', requireUser, (req, res) => {
  const taskId =
    typeof req.query.taskId === 'string' && req.query.taskId
      ? req.query.taskId
      : undefined;
  res.json({
    outcomes: timeMachineStore.listOutcomes(currentUserId(res), taskId),
  });
});

app.get('/api/series', requireUser, (_req, res) => {
  res.json({ series: timeMachineStore.listSeries(currentUserId(res)) });
});

app.get('/api/reminders', requireUser, (req, res) => {
  const status =
    req.query.status === 'sent' ||
    req.query.status === 'dismissed' ||
    req.query.status === 'scheduled'
      ? req.query.status
      : undefined;
  res.json({
    reminders: timeMachineStore.listReminders(currentUserId(res), status),
  });
});

app.post('/api/reminders/:id/dismiss', requireUser, async (req, res, next) => {
  try {
    const dismissed = await timeMachineStore.dismissReminder(
      routeParam(req, 'id'),
      currentUserId(res),
    );
    if (!dismissed) {
      res.status(404).json({ error: 'Reminder not found.' });
      return;
    }
    res.status(204).end();
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
  if (error instanceof TimeMachineError) {
    res.status(error.status).json({
      error: error.message,
      code: error.code,
      details: error.details,
    });
    return;
  }
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
  console.log(
    `Data files: ${dataFile}, ${usersFile}, ${sessionsFile}, ${teamsFile}, ${timeMachineFile}, ${invitesFile}`,
  );
  console.log(
    `Registration: ${inviteOnly ? 'invite-only' : 'open'}; rate limiting: ${rateLimitDisabled ? 'disabled' : 'enabled'}`,
  );
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
