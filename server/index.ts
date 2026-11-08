import express, { type ErrorRequestHandler } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskStore, type TaskPatch } from './store';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataFile = process.env.TODO_DATA_FILE
  ? path.resolve(process.env.TODO_DATA_FILE)
  : path.join(here, 'data', 'tasks.json');
const port = Number(process.env.PORT) || 3001;
const maxTextLength = 500;
const maxMilestoneLength = 1000;

const store = new TaskStore(dataFile);
await store.init();

const app = express();
app.disable('x-powered-by');
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

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, tasks: store.list().length });
});

app.get('/api/tasks', (_req, res) => {
  res.json({ tasks: store.list() });
});

app.get('/api/tasks/:id', (req, res) => {
  const task = store.get(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found.' });
    return;
  }
  res.json({ task });
});

app.post('/api/tasks', async (req, res, next) => {
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

    const task = await store.add(text, dueAt.value ?? null);
    res.status(201).json({ task });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/tasks/:id', async (req, res, next) => {
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

    const task = await store.update(req.params.id, patch);
    if (!task) {
      res.status(404).json({ error: 'Task not found.' });
      return;
    }
    res.json({ task });
  } catch (error) {
    next(error);
  }
});

app.post('/api/tasks/:id/milestones', async (req, res, next) => {
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

    const task = await store.addMilestone(req.params.id, text, progress.value);
    if (!task) {
      res.status(404).json({ error: 'Task not found.' });
      return;
    }
    res.status(201).json({ task });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/tasks/:id', async (req, res, next) => {
  try {
    const removed = await store.remove(req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'Task not found.' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/tasks/clear-completed', async (_req, res, next) => {
  try {
    res.json({ tasks: await store.clearCompleted() });
  } catch (error) {
    next(error);
  }
});

app.put('/api/tasks/order', async (req, res, next) => {
  try {
    const ids = (req.body as { ids?: unknown } | undefined)?.ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      res.status(400).json({ error: '`ids` must be an array of task ids.' });
      return;
    }
    res.json({ tasks: await store.reorder(ids) });
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
  console.log(`Data file: ${dataFile}`);
  if (existsSync(distDir)) {
    console.log(`Serving built UI from ${distDir}`);
  }
});
