import { useState, type FormEvent } from 'react';
import type { User } from '../../shared/types';
import { Header } from './Header';

type Mode = 'login' | 'register' | 'forgot';

interface Props {
  initialError: string | null;
  onSignIn: (email: string, password: string) => Promise<User>;
  onSignUp: (
    email: string,
    password: string,
    inviteCode?: string,
  ) => Promise<User>;
  onRequestReset: (
    email: string,
  ) => Promise<{ sent: boolean; devToken?: string }>;
}

export function AuthScreen({
  initialError,
  onSignIn,
  onSignUp,
  onRequestReset,
}: Props) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);

  const isRegister = mode === 'register';
  const isForgot = mode === 'forgot';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    setDevToken(null);

    if (isForgot) {
      if (!email.trim()) return;
      setBusy(true);
      try {
        const result = await onRequestReset(email.trim());
        setNotice(
          'If an account exists for that email, a password reset link is on its way.',
        );
        if (result.devToken) setDevToken(result.devToken);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong.');
      } finally {
        setBusy(false);
      }
      return;
    }

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
        await onSignUp(email.trim(), password, inviteCode.trim() || undefined);
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
    setMode(isRegister ? 'login' : isForgot ? 'login' : 'register');
    setError(null);
    setNotice(null);
    setDevToken(null);
    setPassword('');
    setConfirm('');
    setInviteCode('');
  }

  return (
    <main className="app auth-app">
      <Header />
      <section className="auth-card">
        <div className="auth-heading">
          <h2>
            {isForgot
              ? 'Reset your password'
              : isRegister
                ? 'Create your account'
                : 'Welcome back'}
          </h2>
          <p>
            {isForgot
              ? 'We will email you a single-use reset link.'
              : isRegister
                ? 'Your tasks stay private to your account.'
                : 'Sign in to see your tasks.'}
          </p>
        </div>

        {(error ?? initialError) && (
          <div className="banner auth-error" role="alert">
            <p>{error ?? initialError}</p>
          </div>
        )}

        {notice && (
          <div className="banner auth-notice" role="status">
            <p>{notice}</p>
            {devToken && (
              <button
                type="button"
                onClick={() => {
                  window.location.search = `?reset=${encodeURIComponent(devToken)}`;
                }}
              >
                Open the reset link
              </button>
            )}
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

          {!isForgot && (
            <label className="auth-field">
              <span>Password</span>
              <div className="auth-password">
                <input
                  type={reveal ? 'text' : 'password'}
                  name="password"
                  autoComplete={
                    isRegister ? 'new-password' : 'current-password'
                  }
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
          )}

          {!isForgot && (
            <p className="auth-hint auth-forgot">
              <button type="button" onClick={() => setMode('forgot')}>
                Forgot your password?
              </button>
            </p>
          )}

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

          {isRegister && (
            <label className="auth-field">
              <span>Invite code (private beta)</span>
              <input
                type="text"
                name="invite-code"
                autoComplete="off"
                value={inviteCode}
                placeholder="Paste your invite code"
                onChange={(event) => setInviteCode(event.target.value)}
              />
              <small className="auth-hint">
                Required while the beta is invite-only.
              </small>
            </label>
          )}

          <button
            className="auth-submit"
            type="submit"
            disabled={
              busy || !email.trim() || (!isForgot && !password)
            }
          >
            {busy
              ? 'Please wait…'
              : isForgot
                ? 'Send reset link'
                : isRegister
                  ? 'Create account'
                  : 'Sign in'}
          </button>
        </form>

        <p className="auth-switch">
          {isForgot
            ? 'Remembered it?'
            : isRegister
              ? 'Already have an account?'
              : 'New here?'}{' '}
          <button type="button" onClick={switchMode}>
            {isForgot || isRegister ? 'Sign in' : 'Create an account'}
          </button>
        </p>
      </section>
    </main>
  );
}
