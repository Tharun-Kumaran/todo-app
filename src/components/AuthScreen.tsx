import { useState, type FormEvent } from 'react';
import type { User } from '../../shared/types';
import { Header } from './Header';

type Mode = 'login' | 'register';

interface Props {
  initialError: string | null;
  onSignIn: (email: string, password: string) => Promise<User>;
  onSignUp: (email: string, password: string) => Promise<User>;
}

export function AuthScreen({ initialError, onSignIn, onSignUp }: Props) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRegister = mode === 'register';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);

    if (isRegister && password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setBusy(true);
    try {
      if (isRegister) {
        await onSignUp(email.trim(), password);
      } else {
        await onSignIn(email.trim(), password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  function switchMode() {
    setMode(isRegister ? 'login' : 'register');
    setError(null);
    setPassword('');
    setConfirm('');
  }

  return (
    <main className="app auth-app">
      <Header />
      <section className="auth-card">
        <div className="auth-heading">
          <h2>{isRegister ? 'Create your account' : 'Welcome back'}</h2>
          <p>
            {isRegister
              ? 'Your tasks stay private to your account.'
              : 'Sign in to see your tasks.'}
          </p>
        </div>

        {(error ?? initialError) && (
          <div className="banner auth-error" role="alert">
            <p>{error ?? initialError}</p>
          </div>
        )}

        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <label className="auth-field">
            <span>Email</span>
            <input
              type="email"
              name="email"
              autoComplete="email"
              autoFocus
              required
              value={email}
              placeholder="you@example.com"
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          <label className="auth-field">
            <span>Password</span>
            <div className="auth-password">
              <input
                type={reveal ? 'text' : 'password'}
                name="password"
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                required
                minLength={8}
                value={password}
                placeholder={
                  isRegister ? 'At least 8 characters' : 'Your password'
                }
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                className="auth-reveal"
                onClick={() => setReveal((value) => !value)}
                aria-label={reveal ? 'Hide password' : 'Show password'}
              >
                {reveal ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>

          {isRegister && (
            <label className="auth-field">
              <span>Confirm password</span>
              <input
                type={reveal ? 'text' : 'password'}
                name="confirm-password"
                autoComplete="new-password"
                required
                minLength={8}
                value={confirm}
                placeholder="Repeat your password"
                onChange={(event) => setConfirm(event.target.value)}
              />
            </label>
          )}

          <button
            className="auth-submit"
            type="submit"
            disabled={busy || !email.trim() || !password}
          >
            {busy
              ? 'Please wait…'
              : isRegister
                ? 'Create account'
                : 'Sign in'}
          </button>
        </form>

        <p className="auth-switch">
          {isRegister ? 'Already have an account?' : 'New here?'}{' '}
          <button type="button" onClick={switchMode}>
            {isRegister ? 'Sign in' : 'Create an account'}
          </button>
        </p>
      </section>
    </main>
  );
}
