import { useCallback, useEffect, useState } from 'react';
import type { User } from '../../shared/types';
import * as api from '../api';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .fetchMe()
      .then((current) => {
        if (cancelled) return;
        setUser(current);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Any task request that comes back 401 means the session is gone.
  useEffect(() => {
    const onUnauthorized = () => setUser(null);
    window.addEventListener('todo:unauthorized', onUnauthorized);
    return () => window.removeEventListener('todo:unauthorized', onUnauthorized);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const next = await api.login(email, password);
    setUser(next);
    setError(null);
    return next;
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    const next = await api.register(email, password);
    setUser(next);
    setError(null);
    return next;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // The local session is cleared even if the server is unreachable.
    } finally {
      setUser(null);
    }
  }, []);

  return { user, loading, error, signIn, signUp, signOut };
}
