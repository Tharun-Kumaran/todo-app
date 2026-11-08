import { useCallback, useEffect, useState } from 'react';
import type { Team } from '../../shared/types';
import * as api from '../api';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export function useTeams() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshTeams = useCallback(async () => {
    setLoading(true);
    try {
      setTeams(await api.fetchTeams());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshTeams();
  }, [refreshTeams]);

  const createNewTeam = useCallback(
    async (name: string): Promise<Team | null> => {
      try {
        const team = await api.createTeam(name);
        setTeams((current) => [team, ...current]);
        setError(null);
        return team;
      } catch (err) {
        setError(errorMessage(err));
        return null;
      }
    },
    [],
  );

  const inviteMember = useCallback(
    async (teamId: string, email: string): Promise<boolean> => {
      try {
        const updated = await api.addTeamMember(teamId, email);
        setTeams((current) =>
          current.map((t) => (t.id === updated.id ? updated : t)),
        );
        setError(null);
        return true;
      } catch (err) {
        setError(errorMessage(err));
        return false;
      }
    },
    [],
  );

  const removeMember = useCallback(
    async (teamId: string, email: string): Promise<boolean> => {
      try {
        const updated = await api.removeTeamMember(teamId, email);
        setTeams((current) =>
          current.map((t) => (t.id === updated.id ? updated : t)),
        );
        setError(null);
        return true;
      } catch (err) {
        setError(errorMessage(err));
        return false;
      }
    },
    [],
  );

  return {
    teams,
    loading,
    error,
    refreshTeams,
    createNewTeam,
    inviteMember,
    removeMember,
    dismissError: () => setError(null),
  };
}
