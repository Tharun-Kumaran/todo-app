import { randomUUID } from 'node:crypto';
import type { Team } from '../shared/types';
import { getDb } from './db/client.ts';
import {
  addTeamMember,
  createTeam,
  getTeamForUser,
  getUserTeamIds,
  isTeamMember,
  linkUserToTeams,
  listTeamsForUser,
  ownedTeams,
  removeTeamMember,
  removeUserFromTeams,
} from './repositories/teams.ts';

/**
 * Team membership lives in Postgres/PGlite. Every read is scoped to a user id
 * or verified team membership, so one account cannot see another team.
 */
export class TeamStore {
  /** Kept for constructor compatibility; the database is the store now. */
  constructor(_file?: string) {}

  async init(): Promise<void> {
    // The database is opened and migrated by the server bootstrap.
  }

  async listForUser(userId: string, userEmail: string): Promise<Team[]> {
    return listTeamsForUser(await getDb(), userId, userEmail);
  }

  async getUserTeamIds(
    userId: string,
    userEmail: string,
  ): Promise<string[]> {
    return getUserTeamIds(await getDb(), userId, userEmail);
  }

  async get(
    teamId: string,
    userId: string,
    userEmail: string,
  ): Promise<Team | null> {
    return getTeamForUser(await getDb(), teamId, userId, userEmail);
  }

  async isMember(
    teamId: string,
    userId: string,
    userEmail: string,
  ): Promise<boolean> {
    return isTeamMember(await getDb(), teamId, userId, userEmail);
  }

  async create(
    ownerId: string,
    ownerEmail: string,
    name: string,
  ): Promise<Team> {
    return createTeam(await getDb(), {
      id: randomUUID(),
      name: name.trim() || 'Untitled Team',
      ownerId,
      ownerEmail,
    });
  }

  /** Link a user's id to any existing team invitations matching their email. */
  async linkUser(userId: string, email: string): Promise<number> {
    return linkUserToTeams(await getDb(), userId, email);
  }

  /** Teams owned by this user; account deletion is blocked while any exist. */
  async ownedBy(userId: string, _userEmail: string): Promise<Team[]> {
    return ownedTeams(await getDb(), userId);
  }

  /** Remove a user's membership from teams they do not own. */
  async removeUser(userId: string, userEmail: string): Promise<number> {
    return removeUserFromTeams(await getDb(), userId, userEmail);
  }

  async addMember(
    teamId: string,
    requesterId: string,
    requesterEmail: string,
    memberEmail: string,
    memberUserId?: string | null,
  ): Promise<{ team: Team | null; error?: string }> {
    return addTeamMember(await getDb(), {
      teamId,
      requesterId,
      requesterEmail,
      memberEmail,
      memberUserId,
    });
  }

  async removeMember(
    teamId: string,
    requesterId: string,
    requesterEmail: string,
    targetEmail: string,
  ): Promise<{ team: Team | null; error?: string }> {
    return removeTeamMember(await getDb(), {
      teamId,
      requesterId,
      requesterEmail,
      targetEmail,
    });
  }
}
