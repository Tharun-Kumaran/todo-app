import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDatabase, type Db, type DbExecutor } from '../server/db/client.ts';
import { runMigrations } from '../server/db/migrate.ts';
import { ensureUserSettings } from '../server/repositories/users.ts';
import { legacyHashToPhc } from '../server/password.ts';
import { normalizeEmail } from '../server/users.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'server', 'data');

interface LegacyUser {
  id: string;
  email: string;
  createdAt?: string;
  salt?: string;
  passwordHash?: string;
}

interface LegacyMember {
  userId?: string | null;
  email: string;
  role?: 'owner' | 'member';
  joinedAt?: string;
}

interface LegacyTeam {
  id: string;
  name: string;
  ownerId: string;
  ownerEmail?: string;
  createdAt?: string;
  members?: LegacyMember[];
}

interface LegacyMilestone {
  id?: string;
  text: string;
  progress?: number;
  createdAt?: string;
}

interface LegacyTask {
  id: string;
  userId?: string | null;
  creatorEmail?: string | null;
  teamId?: string | null;
  assigneeEmail?: string | null;
  text: string;
  done?: boolean;
  progress?: number;
  priority?: string | null;
  category?: string | null;
  dueAt?: string | null;
  scheduledStartAt?: string | null;
  reminderAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  milestones?: LegacyMilestone[];
}

interface FileReport {
  imported: number;
  skipped: number;
  errors: number;
}

interface Report {
  mode: 'dry-run' | 'apply';
  files: { tasks: string; users: string; teams: string };
  users: FileReport;
  teams: FileReport;
  tasks: FileReport;
  milestones: number;
  events: number;
  outcomes: number;
  sessionsSkipped: boolean;
  warnings: string[];
}

interface VerifyReport {
  users: { expected: number; matched: number; missing: string[] };
  teams: { expected: number; matched: number; missing: string[] };
  tasks: { expected: number; matched: number; missing: string[] };
  tasksWithoutEvents: string[];
  milestones: { expected: number; actual: number };
  outcomes: { expected: number; actual: number };
  unmigratable: { users: number; teams: number; tasks: number };
}

function arg(name: string): boolean {
  return process.argv.includes(name);
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function priorityOrNull(value: unknown): string | null {
  return value === 'Low' ||
    value === 'Medium' ||
    value === 'High' ||
    value === 'Urgent'
    ? value
    : null;
}

function clampProgress(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(100, Math.max(0, Math.round(number)));
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Database id columns are UUIDs; legacy files may contain other id formats. */
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function readFile<T>(file: string, key: string): Promise<T[]> {
  return fs
    .readFile(file, 'utf8')
    .then((raw) => {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const value = parsed[key];
      return Array.isArray(value) ? (value as T[]) : [];
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw new Error(`Could not read ${file}: ${error.message}`);
    });
}

async function userExists(
  db: DbExecutor,
  id: string,
  email: string,
): Promise<boolean> {
  const rows = isUuid(id)
    ? await db.query(
        `select 1 from users
          where id = $1 or (lower(email) = lower($2) and deleted_at is null)
          limit 1`,
        [id, email],
      )
    : await db.query(
        'select 1 from users where lower(email) = lower($1) and deleted_at is null limit 1',
        [email],
      );
  return rows.length > 0;
}

async function teamExists(db: DbExecutor, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await db.query('select 1 from teams where id = $1', [id]);
  return rows.length > 0;
}

async function taskExists(db: DbExecutor, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await db.query('select 1 from tasks where id = $1', [id]);
  return rows.length > 0;
}

async function loadUserMap(db: DbExecutor): Promise<Map<string, string>> {
  const rows = await db.query<{ id: string; email: string }>(
    'select id, email from users where deleted_at is null',
  );
  return new Map(rows.map((row) => [row.email.toLowerCase(), row.id]));
}

async function userByIdExists(
  db: DbExecutor,
  id: string,
  usersByEmail: Map<string, string>,
): Promise<boolean> {
  if ([...usersByEmail.values()].includes(id)) return true;
  if (!isUuid(id)) return false;
  const rows = await db.query(
    'select 1 from users where id = $1 and deleted_at is null',
    [id],
  );
  return rows.length > 0;
}

async function importUsers(
  db: DbExecutor,
  users: LegacyUser[],
  dryRun: boolean,
  report: Report,
): Promise<Map<string, string>> {
  const byEmail = await loadUserMap(db);
  const seenIds = new Set<string>();

  for (const [index, user] of users.entries()) {
    const email = normalizeEmail(user.email);
    if (!user.id || !email) {
      report.users.errors += 1;
      report.warnings.push(`users[${index}]: missing id or valid email`);
      continue;
    }
    if (!isUuid(user.id)) {
      report.users.errors += 1;
      report.warnings.push(
        `users[${index}] (${email}): id ${user.id} is not a UUID; account must be re-registered`,
      );
      continue;
    }
    if (seenIds.has(user.id)) {
      report.users.skipped += 1;
      report.warnings.push(`users[${index}]: duplicate id ${user.id}`);
      continue;
    }
    seenIds.add(user.id);

    if (await userExists(db, user.id, email)) {
      report.users.skipped += 1;
      continue;
    }

    let passwordHash = user.passwordHash ?? '';
    if (passwordHash && !passwordHash.startsWith('scrypt$')) {
      if (!user.salt) {
        report.users.errors += 1;
        report.warnings.push(
          `users[${index}] (${email}): legacy hash has no salt; account cannot sign in until reset`,
        );
        continue;
      }
      passwordHash = legacyHashToPhc(user.salt, passwordHash);
    }
    if (!passwordHash) {
      report.users.errors += 1;
      report.warnings.push(`users[${index}] (${email}): missing password hash`);
      continue;
    }

    const createdAt = isoOrNull(user.createdAt) ?? new Date().toISOString();
    if (!dryRun) {
      await db.query(
        `insert into users (id, email, password_hash, created_at, updated_at)
         values ($1, lower($2), $3, $4::timestamptz, $4::timestamptz)`,
        [user.id, email, passwordHash, createdAt],
      );
      await ensureUserSettings(db, user.id);
    }
    byEmail.set(email, user.id);
    report.users.imported += 1;
  }

  return byEmail;
}

async function importTeams(
  db: DbExecutor,
  teams: LegacyTeam[],
  usersByEmail: Map<string, string>,
  dryRun: boolean,
  report: Report,
): Promise<Set<string>> {
  const imported = new Set<string>();
  const seen = new Set<string>();

  for (const [index, team] of teams.entries()) {
    if (!team.id || !team.name || !team.ownerId) {
      report.teams.errors += 1;
      report.warnings.push(`teams[${index}]: missing id, name, or ownerId`);
      continue;
    }
    if (!isUuid(team.id)) {
      report.teams.errors += 1;
      report.warnings.push(
        `teams[${index}] (${team.name}): id ${team.id} is not a UUID`,
      );
      continue;
    }
    if (seen.has(team.id)) {
      report.teams.skipped += 1;
      report.warnings.push(`teams[${index}]: duplicate id ${team.id}`);
      continue;
    }
    seen.add(team.id);

    if (await teamExists(db, team.id)) {
      report.teams.skipped += 1;
      imported.add(team.id);
      continue;
    }

    const ownerEmail =
      normalizeEmail(team.ownerEmail ?? '') ??
      normalizeEmail(
        team.members?.find((member) => member.role === 'owner')?.email ?? '',
      ) ??
      null;
    const ownerId = isUuid(team.ownerId)
      ? team.ownerId
      : ownerEmail
        ? (usersByEmail.get(ownerEmail) ?? null)
        : null;
    if (!ownerId || !(await userByIdExists(db, ownerId, usersByEmail))) {
      report.teams.errors += 1;
      report.warnings.push(
        `teams[${index}] (${team.name}): owner ${team.ownerId} is not imported`,
      );
      continue;
    }

    const createdAt = isoOrNull(team.createdAt) ?? new Date().toISOString();

    if (!dryRun) {
      await db.query(
        `insert into teams (id, name, owner_id, created_at)
         values ($1, $2, $3, $4::timestamptz)`,
        [team.id, team.name, ownerId, createdAt],
      );
      const members = team.members?.length
        ? team.members
        : ownerEmail
          ? [{ email: ownerEmail, role: 'owner' as const, joinedAt: createdAt }]
          : [];
      for (const member of members) {
        const email = normalizeEmail(member.email);
        if (!email) continue;
        const candidate = usersByEmail.get(email) ?? member.userId ?? null;
        const userId =
          candidate && (await userByIdExists(db, candidate, usersByEmail))
            ? candidate
            : null;
        await db.query(
          `insert into team_members (team_id, email, user_id, role, joined_at)
           values ($1, $2, $3, $4, $5::timestamptz)
           on conflict (team_id, email) do nothing`,
          [
            team.id,
            email,
            userId,
            member.role === 'owner' ? 'owner' : 'member',
            isoOrNull(member.joinedAt) ?? createdAt,
          ],
        );
      }
    }
    imported.add(team.id);
    report.teams.imported += 1;
  }

  return imported;
}

async function importTasks(
  db: DbExecutor,
  tasks: LegacyTask[],
  usersByEmail: Map<string, string>,
  importedTeams: Set<string>,
  dryRun: boolean,
  report: Report,
): Promise<void> {
  const seen = new Set<string>();
  const sortCounters = new Map<string, number>();

  for (const [index, task] of tasks.entries()) {
    if (!task.id || !task.text || !task.userId) {
      report.tasks.errors += 1;
      report.warnings.push(
        `tasks[${index}]: missing id, text, or userId (unowned tasks are not imported)`,
      );
      continue;
    }
    if (!isUuid(task.id)) {
      report.tasks.errors += 1;
      report.warnings.push(
        `tasks[${index}] (${task.text.slice(0, 40)}): id ${task.id} is not a UUID`,
      );
      continue;
    }
    if (seen.has(task.id)) {
      report.tasks.skipped += 1;
      report.warnings.push(`tasks[${index}]: duplicate id ${task.id}`);
      continue;
    }
    seen.add(task.id);

    if (await taskExists(db, task.id)) {
      report.tasks.skipped += 1;
      continue;
    }

    const ownerEmail =
      normalizeEmail(task.creatorEmail ?? '') ??
      normalizeEmail(task.assigneeEmail ?? '') ??
      null;
    const ownerId = isUuid(task.userId)
      ? task.userId
      : ownerEmail
        ? (usersByEmail.get(ownerEmail) ?? null)
        : null;
    if (!ownerId || !(await userByIdExists(db, ownerId, usersByEmail))) {
      report.tasks.errors += 1;
      report.warnings.push(
        `tasks[${index}] (${task.text.slice(0, 40)}): owner ${task.userId} is not imported`,
      );
      continue;
    }

    if (task.teamId) {
      if (!isUuid(task.teamId)) {
        report.tasks.errors += 1;
        report.warnings.push(
          `tasks[${index}] (${task.text.slice(0, 40)}): team ${task.teamId} is not a UUID`,
        );
        continue;
      }
      const teamRows = await db.query('select 1 from teams where id = $1', [
        task.teamId,
      ]);
      if (teamRows.length === 0 && !importedTeams.has(task.teamId)) {
        report.tasks.errors += 1;
        report.warnings.push(
          `tasks[${index}] (${task.text.slice(0, 40)}): team ${task.teamId} is not imported`,
        );
        continue;
      }
    }

    const createdAt = isoOrNull(task.createdAt) ?? new Date().toISOString();
    const updatedAt = isoOrNull(task.updatedAt) ?? createdAt;
    const completedAt = task.done
      ? isoOrNull(task.completedAt) ?? updatedAt
      : null;
    const dueAt = isoOrNull(task.dueAt);
    const scopeKey = `${ownerId}:${task.teamId ?? ''}`;
    const sortOrder = sortCounters.get(scopeKey) ?? 0;
    sortCounters.set(scopeKey, sortOrder + 1);

    const milestones = Array.isArray(task.milestones)
      ? task.milestones.filter(
          (milestone) => typeof milestone.text === 'string' && milestone.text,
        )
      : [];
    const progress = clampProgress(task.progress);
    const done = task.done === true || progress >= 100;
    const priority = priorityOrNull(task.priority);

    if (!dryRun) {
      await db.query(
        `insert into tasks
           (id, user_id, team_id, creator_email, assignee_email, text, done,
            progress, priority, category, due_at, scheduled_start_at,
            reminder_at, completed_at, created_at, updated_at, source,
            version, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11::timestamptz, $12::timestamptz, $13::timestamptz,
                 $14::timestamptz, $15::timestamptz, $16::timestamptz,
                 'import', $17, $18)`,
        [
          task.id,
          ownerId,
          task.teamId || null,
          task.creatorEmail ?? null,
          task.assigneeEmail ?? null,
          task.text,
          done,
          done ? 100 : progress,
          priority,
          task.category ?? null,
          dueAt,
          isoOrNull(task.scheduledStartAt),
          isoOrNull(task.reminderAt),
          completedAt,
          createdAt,
          updatedAt,
          typeof task.version === 'number' ? Math.max(1, task.version) : 1,
          sortOrder,
        ],
      );

      await db.query(
        `insert into task_events
           (task_id, user_id, actor_user_id, type, payload, occurred_at)
         values ($1, $2, $2, 'task.created', $3::jsonb, $4::timestamptz)`,
        [
          task.id,
          ownerId,
          JSON.stringify({
            source: 'import',
            dueAt,
            priority,
            category: task.category ?? null,
            backfilled: true,
          }),
          createdAt,
        ],
      );
      report.events += 1;

      for (const milestone of milestones) {
        const milestoneId = isUuid(milestone.id) ? milestone.id : randomUUID();
        const milestoneAt =
          isoOrNull(milestone.createdAt) ?? createdAt;
        const milestoneProgress = clampProgress(milestone.progress);
        await db.query(
          `insert into task_milestones
             (id, task_id, user_id, text, progress, created_at)
           values ($1, $2, $3, $4, $5, $6::timestamptz)`,
          [
            milestoneId,
            task.id,
            ownerId,
            milestone.text,
            milestoneProgress,
            milestoneAt,
          ],
        );
        await db.query(
          `insert into task_events
             (task_id, user_id, actor_user_id, type, payload, occurred_at)
           values ($1, $2, $2, 'task.milestone_added', $3::jsonb, $4::timestamptz)`,
          [
            task.id,
            ownerId,
            JSON.stringify({
              milestoneId,
              progress: milestoneProgress,
              backfilled: true,
            }),
            milestoneAt,
          ],
        );
        report.milestones += 1;
        report.events += 1;
      }

      if (done && completedAt) {
        const late =
          dueAt !== null &&
          Date.parse(completedAt) > Date.parse(dueAt);
        await db.query(
          `insert into task_events
             (task_id, user_id, actor_user_id, type, payload, occurred_at)
           values ($1, $2, $2, 'task.completed', $3::jsonb, $4::timestamptz)`,
          [
            task.id,
            ownerId,
            JSON.stringify({
              completedAt,
              dueAt,
              late,
              backfilled: true,
            }),
            completedAt,
          ],
        );
        report.events += 1;

        await db.query(
          `insert into task_outcomes
             (id, task_id, user_id, horizon, status, observed_at, metadata)
           values ($1, $2, $3, 'deadline', $4, $5::timestamptz, $6::jsonb)
           on conflict (task_id, horizon) do nothing`,
          [
            randomUUID(),
            task.id,
            ownerId,
            late ? 'completed_late' : 'completed_on_time',
            completedAt,
            JSON.stringify({ backfilled: true }),
          ],
        );
        report.outcomes += 1;
      }
    } else {
      report.events += 1 + milestones.length + (done && completedAt ? 1 : 0);
      report.milestones += milestones.length;
      report.outcomes += done && completedAt ? 1 : 0;
    }

    report.tasks.imported += 1;
  }
}

function chunks<T>(items: T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

async function existingIds(
  db: DbExecutor,
  table: 'users' | 'teams' | 'tasks',
  ids: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const group of chunks(ids)) {
    if (group.length === 0) continue;
    const rows = await db.query<{ id: string }>(
      `select id from ${table} where id in (${placeholders(group.length)})`,
      group,
    );
    for (const row of rows) found.add(row.id);
  }
  return found;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, (_, index) => `$${index + 1}`).join(', ');
}

async function verifyMigration(
  db: DbExecutor,
  users: LegacyUser[],
  teams: LegacyTeam[],
  tasks: LegacyTask[],
): Promise<VerifyReport> {
  const expectedUsers = [
    ...new Set(
      users
        .filter(
          (user) => isUuid(user.id) && normalizeEmail(user.email),
        )
        .map((user) => user.id),
    ),
  ];
  const expectedTeams = [
    ...new Set(
      teams
        .filter(
          (team) => isUuid(team.id) && team.name && team.ownerId,
        )
        .map((team) => team.id),
    ),
  ];
  const expectedTasks = [
    ...new Set(
      tasks
        .filter(
          (task) => isUuid(task.id) && task.text && task.userId,
        )
        .map((task) => task.id),
    ),
  ];
  const unmigratable = {
    users: users.filter(
      (user) => user.id && normalizeEmail(user.email) && !isUuid(user.id),
    ).length,
    teams: teams.filter(
      (team) => team.id && team.name && team.ownerId && !isUuid(team.id),
    ).length,
    tasks: tasks.filter(
      (task) => task.id && task.text && task.userId && !isUuid(task.id),
    ).length,
  };

  const foundUsers = await existingIds(db, 'users', expectedUsers);
  const foundTeams = await existingIds(db, 'teams', expectedTeams);
  const foundTasks = await existingIds(db, 'tasks', expectedTasks);

  const tasksWithEvents = new Set<string>();
  const milestoneRows: Array<{ count: number | string }> = [];
  const outcomeRows: Array<{ count: number | string }> = [];
  for (const group of chunks(expectedTasks)) {
    if (group.length === 0) continue;
    const list = placeholders(group.length);
    const events = await db.query<{ task_id: string }>(
      `select distinct task_id from task_events where task_id in (${list})`,
      group,
    );
    for (const row of events) tasksWithEvents.add(row.task_id);
    milestoneRows.push(
      ...(await db.query<{ count: number | string }>(
        `select count(*)::int as count from task_milestones where task_id in (${list})`,
        group,
      )),
    );
    outcomeRows.push(
      ...(await db.query<{ count: number | string }>(
        `select count(*)::int as count from task_outcomes
          where horizon = 'deadline' and task_id in (${list})`,
        group,
      )),
    );
  }

  const knownTasks = new Set(expectedTasks.filter((id) => foundTasks.has(id)));
  const expectedMilestones = tasks
    .filter((task) => task.id && knownTasks.has(task.id))
    .reduce(
      (total, task) =>
        total +
        (Array.isArray(task.milestones)
          ? task.milestones.filter(
              (milestone) =>
                typeof milestone.text === 'string' && milestone.text,
            ).length
          : 0),
      0,
    );
  const expectedOutcomes = tasks.filter(
    (task) => task.id && knownTasks.has(task.id) && task.done === true,
  ).length;

  return {
    users: {
      expected: expectedUsers.length,
      matched: foundUsers.size,
      missing: expectedUsers.filter((id) => !foundUsers.has(id)),
    },
    teams: {
      expected: expectedTeams.length,
      matched: foundTeams.size,
      missing: expectedTeams.filter((id) => !foundTeams.has(id)),
    },
    tasks: {
      expected: expectedTasks.length,
      matched: foundTasks.size,
      missing: expectedTasks.filter((id) => !foundTasks.has(id)),
    },
    tasksWithoutEvents: expectedTasks.filter(
      (id) => foundTasks.has(id) && !tasksWithEvents.has(id),
    ),
    milestones: {
      expected: expectedMilestones,
      actual: milestoneRows.reduce((total, row) => total + Number(row.count), 0),
    },
    outcomes: {
      expected: expectedOutcomes,
      actual: outcomeRows.reduce((total, row) => total + Number(row.count), 0),
    },
    unmigratable,
  };
}

function printVerification(report: VerifyReport): boolean {
  const line = (
    label: string,
    matched: number,
    expected: number,
    missing: string[],
  ): boolean => {
    const ok = matched === expected && missing.length === 0;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${label}: ${matched}/${expected} present${
        missing.length > 0 ? ` (missing ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''})` : ''
      }`,
    );
    return ok;
  };

  let ok = true;
  ok = line('Users ', report.users.matched, report.users.expected, report.users.missing) && ok;
  ok = line('Teams ', report.teams.matched, report.teams.expected, report.teams.missing) && ok;
  ok = line('Tasks ', report.tasks.matched, report.tasks.expected, report.tasks.missing) && ok;

  const eventsOk = report.tasksWithoutEvents.length === 0;
  console.log(
    `${eventsOk ? 'ok  ' : 'FAIL'} Events: ${
      eventsOk
        ? 'every imported task has at least one event'
        : `${report.tasksWithoutEvents.length} imported tasks have no events`
    }`,
  );
  ok = eventsOk && ok;

  const milestonesOk = report.milestones.actual >= report.milestones.expected;
  console.log(
    `${milestonesOk ? 'ok  ' : 'FAIL'} Milestones: ${report.milestones.actual} in database, ${report.milestones.expected} expected`,
  );
  ok = milestonesOk && ok;

  const outcomesOk = report.outcomes.actual >= report.outcomes.expected;
  console.log(
    `${outcomesOk ? 'ok  ' : 'FAIL'} Outcomes: ${report.outcomes.actual} in database, ${report.outcomes.expected} expected`,
  );
  ok = outcomesOk && ok;

  const invalid =
    report.unmigratable.users +
    report.unmigratable.teams +
    report.unmigratable.tasks;
  if (invalid > 0) {
    console.log(
      `warn Unmigratable: ${report.unmigratable.users} users, ${report.unmigratable.teams} teams, and ${report.unmigratable.tasks} tasks have non-UUID ids and were not imported.`,
    );
  }

  console.log(ok ? '\nVerification passed.' : '\nVerification failed.');
  return ok;
}

function printReport(report: Report): void {
  console.log(`Migration mode: ${report.mode}`);
  console.log(`  tasks:  ${report.files.tasks}`);
  console.log(`  users:  ${report.files.users}`);
  console.log(`  teams:  ${report.files.teams}`);
  console.log(
    `Users:  ${report.users.imported} imported, ${report.users.skipped} skipped, ${report.users.errors} errors`,
  );
  console.log(
    `Teams:  ${report.teams.imported} imported, ${report.teams.skipped} skipped, ${report.teams.errors} errors`,
  );
  console.log(
    `Tasks:  ${report.tasks.imported} imported, ${report.tasks.skipped} skipped, ${report.tasks.errors} errors`,
  );
  console.log(
    `Backfill: ${report.milestones} milestones, ${report.events} events, ${report.outcomes} outcomes`,
  );
  console.log(
    'Sessions: not imported; users sign in again to create new sessions.',
  );
  if (report.warnings.length > 0) {
    console.log(`\nWarnings (${report.warnings.length}):`);
    for (const warning of report.warnings.slice(0, 50)) {
      console.log(`  - ${warning}`);
    }
    if (report.warnings.length > 50) {
      console.log(`  ...and ${report.warnings.length - 50} more`);
    }
  }
  if (report.mode === 'dry-run') {
    console.log('\nNo data written. Re-run with --apply to import.');
  }
}

export interface MigrationFiles {
  tasks: string;
  users: string;
  teams: string;
}

export interface MigrationResult {
  report?: Report;
  verification?: VerifyReport;
}

export async function runMigration(options: {
  apply: boolean;
  verify: boolean;
  files: MigrationFiles;
}): Promise<MigrationResult> {
  const { apply, verify, files } = options;
  const report: Report = {
    mode: apply ? 'apply' : 'dry-run',
    files,
    users: { imported: 0, skipped: 0, errors: 0 },
    teams: { imported: 0, skipped: 0, errors: 0 },
    tasks: { imported: 0, skipped: 0, errors: 0 },
    milestones: 0,
    events: 0,
    outcomes: 0,
    sessionsSkipped: true,
    warnings: [],
  };

  const users = await readFile<LegacyUser>(files.users, 'users');
  const teams = await readFile<LegacyTeam>(files.teams, 'teams');
  const tasks = await readFile<LegacyTask>(files.tasks, 'tasks');

  const db: Db = await createDatabase();
  try {
    await runMigrations(db);
    if (verify) {
      return { verification: await verifyMigration(db, users, teams, tasks) };
    }
    if (apply) {
      await db.transaction(async (tx) => {
        const usersByEmail = await importUsers(tx, users, false, report);
        const importedTeams = await importTeams(
          tx,
          teams,
          usersByEmail,
          false,
          report,
        );
        await importTasks(
          tx,
          tasks,
          usersByEmail,
          importedTeams,
          false,
          report,
        );
      });
    } else {
      const usersByEmail = await importUsers(db, users, true, report);
      const importedTeams = await importTeams(
        db,
        teams,
        usersByEmail,
        true,
        report,
      );
      await importTasks(db, tasks, usersByEmail, importedTeams, true, report);
    }
  } finally {
    await db.close();
  }

  return { report };
}

async function main(): Promise<void> {
  const apply = arg('--apply');
  const verify = arg('--verify');
  const explicitDryRun = arg('--dry-run');
  if (apply && verify) {
    console.error('Use either --apply or --verify, not both.');
    process.exitCode = 1;
    return;
  }
  if (!apply && !verify && !explicitDryRun && !arg('--help')) {
    console.log('No mode supplied; running a dry run. Pass --apply to write.');
  }
  if (arg('--help')) {
    console.log(
      'Usage: npm run migrate:json -- [--dry-run | --apply | --verify]\n' +
        '  --dry-run  Report what would be imported without writing (default).\n' +
        '  --apply    Import users, teams, tasks, milestones, events, and outcomes.\n' +
        '  --verify   Check that every record from the JSON files exists in the database.\n' +
        'Reads server/data (or TODO_*_FILE overrides) and uses the configured database.',
    );
    return;
  }

  const files: MigrationFiles = {
    tasks: process.env.TODO_DATA_FILE
      ? path.resolve(process.env.TODO_DATA_FILE)
      : path.join(dataDir, 'tasks.json'),
    users: process.env.TODO_USERS_FILE
      ? path.resolve(process.env.TODO_USERS_FILE)
      : path.join(dataDir, 'users.json'),
    teams: process.env.TODO_TEAMS_FILE
      ? path.resolve(process.env.TODO_TEAMS_FILE)
      : path.join(dataDir, 'teams.json'),
  };

  const { report, verification } = await runMigration({ apply, verify, files });

  if (verification) {
    if (!printVerification(verification)) process.exitCode = 1;
    return;
  }
  if (!report) return;

  printReport(report);
  if (
    report.users.errors > 0 ||
    report.teams.errors > 0 ||
    report.tasks.errors > 0
  ) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
