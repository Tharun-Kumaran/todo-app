import { useEffect, useRef, useState, type FormEvent } from 'react';
import * as api from '../api';
import { Header } from './Header';

export type AccountAction =
  | { kind: 'verify'; token: string }
  | { kind: 'reset'; token: string };

interface Props {
  action: AccountAction;
  onFinish: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export function AccountActionScreen({ action, onFinish }: Props) {
  const [busy, setBusy] = useState(action.kind === 'verify');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (action.kind !== 'verify' || started.current) return;
    started.current = true;
    let active = true;
    void api
      .verifyEmail(action.token)
      .then(() => {
        if (active) {
          setDone(true);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) setError(errorMessage(err));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [action]);

  async function submitReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      await api.resetPassword(action.token, password);
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const isVerify = action.kind === 'verify';

  return (
    <main className="app auth-app">
      <Header />
      <section className="auth-card">
        <div className="auth-heading">
          <h2>{isVerify ? 'Verify your email' : 'Choose a new password'}</h2>
          <p>
            {done
              ? isVerify
                ? 'Your email address is verified.'
                : 'Your password was changed and other sessions were signed out.'
              : isVerify
                ? 'Confirming your verification link…'
                : 'Set a new password for your account.'}
          </p>
        </div>

        {error && (
          <div className="banner auth-error" role="alert">
            <p>{error}</p>
          </div>
        )}

        {!done && !isVerify && (
          <form className="auth-form" onSubmit={(event) => void submitReset(event)}>
            <label className="auth-field">
              <span>New password</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                autoFocus
                value={password}
                placeholder="At least 8 characters"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label className="auth-field">
              <span>Confirm new password</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={confirm}
                placeholder="Repeat your password"
                onChange={(event) => setConfirm(event.target.value)}
              />
            </label>
            <button
              className="auth-submit"
              type="submit"
              disabled={busy || !password || !confirm}
            >
              {busy ? 'Saving…' : 'Reset password'}
            </button>
          </form>
        )}

        {isVerify && busy && (
          <div className="loading security-loading" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            Verifying…
          </div>
        )}

        {(done || (error && isVerify)) && (
          <button className="auth-submit" type="button" onClick={onFinish}>
            Continue to sign in
          </button>
        )}
      </section>
    </main>
  );
}
