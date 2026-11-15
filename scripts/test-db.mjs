/**
 * Runs the full test suite against a throwaway PGlite database.
 *
 * Starts the API on a free port with all runtime data redirected into a
 * temporary directory, waits for `/api/health`, runs `npm test`, then stops the
 * server and deletes the temporary data. No local data is read or written.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(base, child, logs) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`API exited early with code ${child.exitCode}\n${logs()}`);
    }
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      // Server not listening yet.
    }
    await sleep(250);
  }
  throw new Error(`API did not become healthy within 120s\n${logs()}`);
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000).unref();
  });
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-test-db-'));
const port = await freePort();
const base = `http://localhost:${port}`;
const env = {
  ...process.env,
  PORT: String(port),
  API_BASE: base,
  DB_DRIVER: 'pglite',
  PGLITE_DATA_DIR: path.join(dir, 'db'),
  TODO_TIME_MACHINE_FILE: path.join(dir, 'time-machine.json'),
  TODO_INVITES_FILE: path.join(dir, 'invites.json'),
  TODO_INVITE_ONLY: '',
  TODO_RATE_LIMIT_DISABLED: '1',
};

let server;
let serverLogs = '';
try {
  console.log(`Starting API on ${base} with a temporary PGlite database...`);
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.setEncoding('utf8');
  server.stderr.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    serverLogs += chunk;
  });
  server.stderr.on('data', (chunk) => {
    serverLogs += chunk;
  });

  await waitForHealth(base, server, () => serverLogs);

  console.log('API healthy. Running the test suite...\n');
  const tests = spawn(npm, ['test'], {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const code = await new Promise((resolve) =>
    tests.once('exit', (value) => resolve(value ?? 1)),
  );
  if (code !== 0) process.exitCode = code;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (server) await stop(server);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
