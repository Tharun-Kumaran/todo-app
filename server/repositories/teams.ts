import type { Team, TeamMember } from '../../shared/types';
import type { Db, DbExecutor } from '../db/client.ts';
import { normalizeEmail } from '../users.ts';

interface TeamRow extends Record<string, unknown> {
  id: string;
  name: string;
  owner_id: string;
  owner_email: string;
  created_at: Date | string;
}

interface MemberRow extends Record<string, unknown> {
  team_id: string;
  email: string;
  user_id: string | null;
  role: 'owner' | 'member';
  joined_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toMember(row: MemberRow): TeamMember {
  return {
    userId: row.user_id,
    email: row.email,
    role: row.role,
    joinedAt: toIso(row.joined_at),
  };
}

function toTeam(row: TeamRow, members: TeamMember[]): Team {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    ownerEmail: row.owner_email,
    members,
    createdAt: toIso(row.created_at),
  };
}

function placeholders(count: number, start = 1): string {
  return Array.from({ length: count }, (_, index) => `$${start + index}`).join(', ');
}

async function loadMembers(
  db: DbExecutor,
  teamIds: string[],
): Promise<Map<string, TeamMember[]>> {
  const map = new Map<string, TeamMember[]>();
  if (teamIds.length === 0) return map;
  const rows = await db.query<MemberRow>(
    `select team_id, email, user_id, role, joined_at
       from team_members
      where team_id in (${placeholders(teamIds.length)})
      order by joined_at asc`,
    teamIds,
  );
  for (const row of rows) {
    const list = map.get(row.team_id) ?? [];
    list.push(toMember(row));
    map.set(row.team_id, list);
  }
  return map;
}

async function loadTeams(
  db: DbExecutor,
  rows: TeamRow[],
): Promise<Team[]> {
  const members = await loadMembers(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toTeam(row, members.get(row.id) ?? []));
}

const TEAM_SELECT = `
  select t.id, t.name, t.owner_id, u.email as owner_email, t.created_at
    from teams t
    join users u on u.id = t.owner_id
`;

export async function listTeamsForUser(
  db: Db,
  userId: string,
  userEmail: string,
): Promise<Team[]> {
  const rows = await db.query<TeamRow>(
    `${TEAM_SELECT}
      where t.archived_at is null
        and (
          t.owner_id = $1
          or exists (
            select 1 from team_members m
             where m.team_id = t.id
               and (m.user_id = $1 or lower(m.email) = lower($2))
          )
        )
      order by t.created_at desc`,
    [userId, userEmail],
  );
  return loadTeams(db, rows);
}

export async function getUserTeamIds(
  db: Db,
  userId: string,
  userEmail: string,
): Promise<string[]> {
  const teams = await listTeamsForUser(db, userId, userEmail);
  return teams.map((team) => team.id);
}

export async function getTeamForUser(
  db: Db,
  teamId: string,
  userId: string,
  userEmail: string,
): Promise<Team | null> {
  const rows = await db.query<TeamRow>(
    `${TEAM_SELECT}
      where t.id = $1
        and t.archived_at is null
        and (
          t.owner_id = $2
          or exists (
            select 1 from team_members m
             where m.team_id = t.id
               and (m.user_id = $2 or lower(m.email) = lower($3))
          )
        )`,
    [teamId, userId, userEmail],
  );
  if (!rows[0]) return null;
  const [team] = await loadTeams(db, rows);
  return team ?? null;
}

export async function isTeamMember(
  db: Db,
  teamId: string,
  userId: string,
  userEmail: string,
): Promise<boolean> {
  return (await getTeamForUser(db, teamId, userId, userEmail)) !== null;
}

export async function createTeam(
  db: Db,
  input: {
    id: string;
    name: string;
    ownerId: string;
    ownerEmail: string;
    createdAt?: string;
  },
): Promise<Team> {
  return db.transaction(async (tx) => {
    await tx.query(
      `insert into teams (id, name, owner_id, created_at)
       values ($1, $2, $3, coalesce($4::timestamptz, now()))`,
      [input.id, input.name, input.ownerId, input.createdAt ?? null],
    );
    await tx.query(
      `insert into team_members (team_id, email, user_id, role, joined_at)
       values ($1, lower($2), $3, 'owner', coalesce($4::timestamptz, now()))`,
      [input.id, input.ownerEmail, input.ownerId, input.createdAt ?? null],
    );
    const rows = await tx.query<TeamRow>(
      `${TEAM_SELECT} where t.id = $1`,
      [input.id],
    );
    const [team] = await loadTeams(tx, rows);
    if (!team) throw new Error('Team insert did not return a row.');
    return team;
  });
}

export async function linkUserToTeams(
  db: Db,
  userId: string,
  email: string,
): Promise<number> {
  const rows = await db.query<{ team_id: string }>(
    `update team_members
        set user_id = $1
      where lower(email) = lower($2)
        and (user_id is null or user_id <> $1)
      returning team_id`,
    [userId, email],
  );
  return rows.length;
}

export async function ownedTeams(
  db: Db,
  userId: string,
): Promise<Team[]> {
  const rows = await db.query<TeamRow>(
    `${TEAM_SELECT}
      where t.owner_id = $1 and t.archived_at is null
      order by t.created_at desc`,
    [userId],
  );
  return loadTeams(db, rows);
}

export async function removeUserFromTeams(
  db: Db,
  userId: string,
  userEmail: string,
): Promise<number> {
  const rows = await db.query<{ team_id: string }>(
    `delete from team_members
      where (user_id = $1 or lower(email) = lower($2))
        and team_id not in (select id from teams where owner_id = $1)
      returning team_id`,
    [userId, userEmail],
  );
  return rows.length;
}

export async function addTeamMember(
  db: Db,
  input: {
    teamId: string;
    requesterId: string;
    requesterEmail: string;
    memberEmail: string;
    memberUserId?: string | null;
  },
): Promise<{ team: Team | null; error?: string }> {
  const email = normalizeEmail(input.memberEmail);
  if (!email) {
    return { team: null, error: 'Enter a valid email address.' };
  }

  return db.transaction(async (tx) => {
    const teamRows = await tx.query<TeamRow>(
      `${TEAM_SELECT} where t.id = $1 and t.archived_at is null for update of t`,
      [input.teamId],
    );
    if (!teamRows[0]) {
      return { team: null, error: 'Team not found.' };
    }
    const [team] = await loadTeams(tx, teamRows);
    if (!team) return { team: null, error: 'Team not found.' };

    const requester = input.requesterEmail.toLowerCase();
    const isMember =
      team.ownerId === input.requesterId ||
      team.ownerEmail.toLowerCase() === requester ||
      team.members.some(
        (member) =>
          member.userId === input.requesterId ||
          member.email.toLowerCase() === requester,
      );
    if (!isMember) {
      return { team: null, error: 'Permission denied.' };
    }
    if (team.members.some((member) => member.email.toLowerCase() === email)) {
      return { team: null, error: 'User is already a member of this team.' };
    }

    await tx.query(
      `insert into team_members (team_id, email, user_id, role)
       values ($1, $2, $3, 'member')`,
      [input.teamId, email, input.memberUserId ?? null],
    );
    const updatedRows = await tx.query<TeamRow>(
      `${TEAM_SELECT} where t.id = $1`,
      [input.teamId],
    );
    const [updated] = await loadTeams(tx, updatedRows);
    return { team: updated ?? null };
  });
}

export async function removeTeamMember(
  db: Db,
  input: {
    teamId: string;
    requesterId: string;
    requesterEmail: string;
    targetEmail: string;
  },
): Promise<{ team: Team | null; error?: string }> {
  const target = input.targetEmail.toLowerCase();

  return db.transaction(async (tx) => {
    const teamRows = await tx.query<TeamRow>(
      `${TEAM_SELECT} where t.id = $1 and t.archived_at is null for update of t`,
      [input.teamId],
    );
    if (!teamRows[0]) {
      return { team: null, error: 'Team not found.' };
    }
    const [team] = await loadTeams(tx, teamRows);
    if (!team) return { team: null, error: 'Team not found.' };

    const requester = input.requesterEmail.toLowerCase();
    const isOwner =
      team.ownerId === input.requesterId ||
      team.ownerEmail.toLowerCase() === requester;
    const isSelf = requester === target;
    if (!isOwner && !isSelf) {
      return {
        team: null,
        error:
          'Only the host or the member themselves can remove this member.',
      };
    }
    if (team.ownerEmail.toLowerCase() === target) {
      return { team: null, error: 'The team host cannot be removed.' };
    }

    await tx.query(
      'delete from team_members where team_id = $1 and lower(email) = lower($2)',
      [input.teamId, target],
    );
    const updatedRows = await tx.query<TeamRow>(
      `${TEAM_SELECT} where t.id = $1`,
      [input.teamId],
    );
    const [updated] = await loadTeams(tx, updatedRows);
    return { team: updated ?? null };
  });
}
