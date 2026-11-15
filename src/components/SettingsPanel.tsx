import { useEffect, useState, type FormEvent } from 'react';
import type { User, UserSettings } from '../../shared/types';
import * as api from '../api';

interface Props {
  user: User;
  onClose: () => void;
  onUserUpdated: (user: User) => void;
}

type BooleanSetting = {
  key: keyof Pick<
    UserSettings,
    | 'predictionEnabled'
    | 'recommendationsEnabled'
    | 'sharedLearningOptIn'
    | 'llmOptIn'
    | 'recurrenceAutoCreateDefault'
    | 'emailRemindersEnabled'
  >;
  label: string;
  detail: string;
};

const BOOLEAN_SETTINGS: BooleanSetting[] = [
  {
    key: 'predictionEnabled',
    label: 'Personalized predictions',
    detail:
      'Use your own completion history to calibrate Time Machine forecasts. Turn off to use the cold-start baseline and stop recording new predictions.',
  },
  {
    key: 'recommendationsEnabled',
    label: 'Show recommendations',
    detail:
      'Suggest deadline, scheduling, subtask, reminder, and recurrence changes on personal tasks.',
  },
  {
    key: 'recurrenceAutoCreateDefault',
    label: 'Auto-create recurring tasks by default',
    detail:
      'New recurring series create their next task automatically when you accept a recurrence suggestion. You can still change each series.',
  },
  {
    key: 'emailRemindersEnabled',
    label: 'Email reminders',
    detail:
      'Allow reminders to be delivered by email. In-app reminders still work when this is off.',
  },
  {
    key: 'sharedLearningOptIn',
    label: 'Shared learning (beta)',
    detail:
      'Allow anonymized completion patterns to improve shared model calibration. Your task text is never shared. Off by default.',
  },
  {
    key: 'llmOptIn',
    label: 'AI assistance (opt-in)',
    detail:
      'Allow sending task text to a language model for subtask suggestions and explanations when the feature launches. Off by default.',
  },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export function SettingsPanel({ user, onClose, onUserUpdated }: Props) {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [timezone, setTimezone] = useState('');
  const [locale, setLocale] = useState('');
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyToken, setVerifyToken] = useState<string | null>(null);
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .fetchSettings()
      .then((next) => {
        if (!active) return;
        setSettings(next);
        setTimezone(next.timezone);
        setLocale(next.locale);
      })
      .catch((err) => {
        if (active) setError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, []);

  async function toggle(key: BooleanSetting['key'], value: boolean) {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, [key]: value });
    setBusyKey(key);
    setError(null);
    try {
      const next = await api.updateSettings({ [key]: value });
      setSettings(next);
    } catch (err) {
      setSettings(previous);
      setError(errorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function savePreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings || savingPreferences) return;
    setSavingPreferences(true);
    setError(null);
    try {
      const next = await api.updateSettings({
        timezone: timezone.trim(),
        locale: locale.trim(),
      });
      setSettings(next);
      setTimezone(next.timezone);
      setLocale(next.locale);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSavingPreferences(false);
    }
  }

  async function sendVerification() {
    if (verifyBusy) return;
    setVerifyBusy(true);
    setError(null);
    setVerifyMessage(null);
    try {
      const result = await api.requestEmailVerification();
      if (result.alreadyVerified) {
        setVerifyMessage('Your email is already verified.');
      } else if (result.devToken) {
        setVerifyToken(result.devToken);
        setVerifyMessage(
          'Development mode: use the button below instead of waiting for email.',
        );
      } else {
        setVerifyMessage('Verification email sent. Check your inbox.');
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setVerifyBusy(false);
    }
  }

  async function confirmVerification() {
    if (!verifyToken || verifyBusy) return;
    setVerifyBusy(true);
    setError(null);
    try {
      const updated = await api.verifyEmail(verifyToken);
      onUserUpdated(updated);
      setVerifyToken(null);
      setVerifyMessage('Email verified. Thank you!');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setVerifyBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="security-panel settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="security-head">
          <div>
            <h2 id="settings-title">Settings</h2>
            <p>Privacy, predictions, reminders, and recurring tasks.</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close settings"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        {error && (
          <div className="banner auth-error" role="alert">
            <p>{error}</p>
          </div>
        )}

        <section className="security-section">
          <div className="security-section-head">
            <h3>Email</h3>
            <span
              className={`settings-badge ${
                user.emailVerifiedAt ? 'is-verified' : ''
              }`}
            >
              {user.emailVerifiedAt ? 'Verified' : 'Not verified'}
            </span>
          </div>
          <p className="security-note">
            {user.emailVerifiedAt
              ? 'Your email address is verified. Password reset links can be sent to it.'
              : 'Verify your email so we can send password reset and reminder emails.'}
          </p>
          {!user.emailVerifiedAt && (
            <div className="settings-actions">
              <button
                type="button"
                className="ghost-btn"
                disabled={verifyBusy}
                onClick={() => void sendVerification()}
              >
                {verifyBusy ? 'Working…' : 'Send verification email'}
              </button>
              {verifyToken && (
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={verifyBusy}
                  onClick={() => void confirmVerification()}
                >
                  Verify now
                </button>
              )}
            </div>
          )}
          {verifyMessage && <p className="security-note">{verifyMessage}</p>}
        </section>

        <section className="security-section">
          <div className="security-section-head">
            <h3>Privacy and features</h3>
          </div>
          <ul className="settings-list">
            {BOOLEAN_SETTINGS.map((setting) => {
              const checked = settings?.[setting.key] ?? false;
              return (
                <li key={setting.key} className="settings-row">
                  <div className="settings-copy">
                    <strong>{setting.label}</strong>
                    <span>{setting.detail}</span>
                  </div>
                  <label className="settings-switch">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!settings || busyKey !== null}
                      onChange={(event) =>
                        void toggle(setting.key, event.target.checked)
                      }
                    />
                    <span aria-hidden="true" />
                  </label>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="security-section">
          <div className="security-section-head">
            <h3>Time zone and language</h3>
          </div>
          <form
            className="settings-prefs"
            onSubmit={(event) => void savePreferences(event)}
          >
            <label className="auth-field">
              <span>IANA time zone</span>
              <input
                type="text"
                value={timezone}
                placeholder="Europe/London"
                onChange={(event) => setTimezone(event.target.value)}
              />
            </label>
            <label className="auth-field">
              <span>Language tag</span>
              <input
                type="text"
                value={locale}
                placeholder="en-US"
                onChange={(event) => setLocale(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="post-btn"
              disabled={
                savingPreferences ||
                !settings ||
                !timezone.trim() ||
                !locale.trim()
              }
            >
              {savingPreferences ? 'Saving…' : 'Save preferences'}
            </button>
          </form>
        </section>
      </section>
    </div>
  );
}
