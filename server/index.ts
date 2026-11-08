import express, { type ErrorRequestHandler } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskStore } from './store';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataFile = process.env.TODO_DATA_FILE
  ? path.resolve(process.env.TODO_DATA_FILE)
  : path.join(here, 'data', 'tasks.json');
const port = Number(process.env.PORT) || 3001;
const maxTextLength = 500;

const store = new TaskStore(dataFile);
await store.init();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));

function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxTextLength) : null;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, tasks: store.list().length });
});

app.get('/api/tasks', (_req, res) => {
  res.json({ tasks: store.list() });
});

app.post('/api/tasks', async (req, res, next) => {
  try {
    const text = readText((req.body as { text?: unknown } | undefined)?.text);
    if (!text) {
      res.status(400).json({ error: 'Task text is required.' });
      return;
    }
    const task = await store.add(text);
    res.status(201).json({ task });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/tasks/:id', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { text?: unknown; done?: unknown };
    const patch: { text?: string; done?: boolean } = {};

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
