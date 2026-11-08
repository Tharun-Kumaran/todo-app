import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Team, TeamMember } from '../shared/types';
import { normalizeEmail } from './users';

interface TeamFile {
  version: 1;
  teams: Team[];
}

function cloneTeam(team: Team): Team {
  return {
    ...team,
    members: team.members.map((m) => ({ ...m })),
  };
}

export class TeamStore {
  private teams: Team[] = [];
  private opChain: Promise<unknown> = Promise.resolve();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<TeamFile>;
      this.teams = Array.isArray(parsed.teams) ? parsed.teams.map(cloneTeam) : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.error(`Could not read ${this.file}; starting with no teams.`, error);
        try {
          await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          // Ignore rename error
        }
      }
      this.teams = [];
      await this.persist([]);
    }
  }

  listForUser(userId: string, userEmail: string): Team[] {
    const normalized = userEmail.toLowerCase();
    return this.teams
      .filter((t) => this.isMemberDirect(t, userId, normalized))
      .map(cloneTeam);
  }

  getUserTeamIds(userId: string, userEmail: string): string[] {
    const normalized = userEmail.toLowerCase();
    return this.teams
      .filter((t) => this.isMemberDirect(t, userId, normalized))
      .map((t) => t.id);
  }

  get(teamId: string, userId: string, userEmail: string): Team | null {
    const normalized = userEmail.toLowerCase();
    const team = this.teams.find((t) => t.id === teamId);
    if (!team || !this.isMemberDirect(team, userId, normalized)) return null;
    return cloneTeam(team);
  }

  isMember(teamId: string, userId: string, userEmail: string): boolean {
    const team = this.teams.find((t) => t.id === teamId);
    if (!team) return false;
    return this.isMemberDirect(team, userId, userEmail.toLowerCase());
  }

  private isMemberDirect(team: Team, userId: string, userEmailNormalized: string): boolean {
    if (team.ownerId === userId || team.ownerEmail.toLowerCase() === userEmailNormalized) {
      return true;
    }
    return team.members.some(
      (m) =>
        (m.userId && m.userId === userId) ||
        m.email.toLowerCase() === userEmailNormalized,
    );
  }

  create(ownerId: string, ownerEmail: string, name: string): Promise<Team> {
    const now = new Date().toISOString();
    const ownerMember: TeamMember = {
      userId: ownerId,
      email: ownerEmail.toLowerCase(),
      role: 'owner',
      joinedAt: now,
    };
    const team: Team = {
      id: randomUUID(),
      name: name.trim() || 'Untitled Team',
      ownerId,
      ownerEmail: ownerEmail.toLowerCase(),
      members: [ownerMember],
      createdAt: now,
    };

    return this.mutate((teams) => ({
      next: [team, ...teams],
      result: cloneTeam(team),
    }));
  }

  /** Link a user's id to any existing team invitations or ownerships matching their email. */
  linkUser(userId: string, email: string): Promise<number> {
    const normalized = email.toLowerCase();
    return this.mutate((teams) => {
      let linked = 0;
      const next = teams.map((team) => {
        let changed = false;
        const members = team.members.map((m) => {
          if (m.email.toLowerCase() === normalized && m.userId !== userId) {
            changed = true;
            linked += 1;
            return { ...m, userId };
          }
          return m;
        });
        if (
          team.ownerEmail.toLowerCase() === normalized &&
          team.ownerId !== userId
        ) {
          changed = true;
          return { ...team, ownerId: userId, members };
        }
        return changed ? { ...team, members } : team;
      });
      return { next, result: linked };
    });
  }

  addMember(
    teamId: string,
    requesterId: string,
    requesterEmail: string,
    memberEmail: string,
    memberUserId?: string | null,
  ): Promise<{ team: Team | null; error?: string }> {
    return this.mutate<{ team: Team | null; error?: string }>((teams) => {
      const team = teams.find((t) => t.id === teamId);
      if (!team) return { next: teams, result: { team: null, error: 'Team not found.' } };

      const requesterNorm = requesterEmail.toLowerCase();
      if (!this.isMemberDirect(team, requesterId, requesterNorm)) {
        return { next: teams, result: { team: null, error: 'Permission denied.' } };
      }

      const emailNorm = normalizeEmail(memberEmail);
      if (!emailNorm) {
        return { next: teams, result: { team: null, error: 'Enter a valid email address.' } };
      }

      if (team.members.some((m) => m.email.toLowerCase() === emailNorm)) {
        return { next: teams, result: { team: null, error: 'User is already a member of this team.' } };
      }

      const now = new Date().toISOString();
      const newMember: TeamMember = {
        userId: memberUserId ?? null,
        email: emailNorm,
        role: 'member',
        joinedAt: now,
      };

      const updated: Team = {
        ...team,
        members: [...team.members, newMember],
      };

      const next = teams.map((t) => (t.id === teamId ? updated : t));
      return { next, result: { team: cloneTeam(updated) } };
    });
  }

  removeMember(
    teamId: string,
    requesterId: string,
    requesterEmail: string,
    targetEmail: string,
  ): Promise<{ team: Team | null; error?: string }> {
    return this.mutate<{ team: Team | null; error?: string }>((teams) => {
      const team = teams.find((t) => t.id === teamId);
      if (!team) return { next: teams, result: { team: null, error: 'Team not found.' } };

      const requesterNorm = requesterEmail.toLowerCase();
      const targetNorm = targetEmail.toLowerCase();

      const isOwner = team.ownerId === requesterId || team.ownerEmail.toLowerCase() === requesterNorm;
      const isSelf = requesterNorm === targetNorm;

      if (!isOwner && !isSelf) {
        return { next: teams, result: { team: null, error: 'Only the host or the member themselves can remove this member.' } };
      }

      if (team.ownerEmail.toLowerCase() === targetNorm) {
        return { next: teams, result: { team: null, error: 'The team host cannot be removed.' } };
      }

      const updated: Team = {
        ...team,
        members: team.members.filter((m) => m.email.toLowerCase() !== targetNorm),
      };

      const next = teams.map((t) => (t.id === teamId ? updated : t));
      return { next, result: { team: cloneTeam(updated) } };
    });
  }

  private mutate<T>(
    fn: (teams: Team[]) => { next: Team[]; result: T },
  ): Promise<T> {
    const run = this.opChain.then(async () => {
      const { next, result } = fn(this.teams.map(cloneTeam));
      await this.persist(next);
      this.teams = next;
      return result;
    });
    this.opChain = run.catch(() => {});
    return run;
  }

  private async persist(teams: Team[]): Promise<void> {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true });
    const temp = `${this.file}.tmp-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const payload: TeamFile = { version: 1, teams };
    await fs.writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(temp, this.file);
  }
}
