import type { Db } from '../db/client.ts';

export interface UserSettings {
  userId: string;
  timezone: string;
  locale: string;
  predictionEnabled: boolean;
  recommendationsEnabled: boolean;
  sharedLearningOptIn: boolean;
  llmOptIn: boolean;
  recurrenceAutoCreateDefault: boolean;
  emailRemindersEnabled: boolean;
  updatedAt: string;
}

interface SettingsRow extends Record<string, unknown> {
  user_id: string;
  timezone: string;
  locale: string;
  prediction_enabled: boolean;
  recommendations_enabled: boolean;
  shared_learning_opt_in: boolean;
  llm_opt_in: boolean;
  recurrence_auto_create_default: boolean;
  email_reminders_enabled: boolean;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toSettings(row: SettingsRow): UserSettings {
  return {
    userId: row.user_id,
    timezone: row.timezone,
    locale: row.locale,
    predictionEnabled: row.prediction_enabled,
    recommendationsEnabled: row.recommendations_enabled,
    sharedLearningOptIn: row.shared_learning_opt_in,
    llmOptIn: row.llm_opt_in,
    recurrenceAutoCreateDefault: row.recurrence_auto_create_default,
    emailRemindersEnabled: row.email_reminders_enabled,
    updatedAt: toIso(row.updated_at),
  };
}

export async function getUserSettings(
  db: Db,
  userId: string,
): Promise<UserSettings | null> {
  const rows = await db.query<SettingsRow>(
    `select user_id, timezone, locale, prediction_enabled,
            recommendations_enabled, shared_learning_opt_in, llm_opt_in,
            recurrence_auto_create_default, email_reminders_enabled, updated_at
       from user_settings
      where user_id = $1`,
    [userId],
  );
  return rows[0] ? toSettings(rows[0]) : null;
}

export async function updateUserSettings(
  db: Db,
  userId: string,
  patch: Partial<{
    timezone: string;
    locale: string;
    predictionEnabled: boolean;
    recommendationsEnabled: boolean;
    sharedLearningOptIn: boolean;
    llmOptIn: boolean;
    recurrenceAutoCreateDefault: boolean;
    emailRemindersEnabled: boolean;
  }>,
): Promise<UserSettings> {
  await db.query(
    `insert into user_settings (user_id)
     values ($1)
     on conflict (user_id) do nothing`,
    [userId],
  );
  const current = await getUserSettings(db, userId);
  if (!current) throw new Error('Could not create user settings.');

  const next = {
    timezone: patch.timezone ?? current.timezone,
    locale: patch.locale ?? current.locale,
    predictionEnabled: patch.predictionEnabled ?? current.predictionEnabled,
    recommendationsEnabled:
      patch.recommendationsEnabled ?? current.recommendationsEnabled,
    sharedLearningOptIn:
      patch.sharedLearningOptIn ?? current.sharedLearningOptIn,
    llmOptIn: patch.llmOptIn ?? current.llmOptIn,
    recurrenceAutoCreateDefault:
      patch.recurrenceAutoCreateDefault ?? current.recurrenceAutoCreateDefault,
    emailRemindersEnabled:
      patch.emailRemindersEnabled ?? current.emailRemindersEnabled,
  };
  const updated = await db.query<SettingsRow>(
    `update user_settings
        set timezone = $2,
            locale = $3,
            prediction_enabled = $4,
            recommendations_enabled = $5,
            shared_learning_opt_in = $6,
            llm_opt_in = $7,
            recurrence_auto_create_default = $8,
            email_reminders_enabled = $9,
            updated_at = now()
      where user_id = $1
      returning user_id, timezone, locale, prediction_enabled,
                recommendations_enabled, shared_learning_opt_in, llm_opt_in,
                recurrence_auto_create_default, email_reminders_enabled, updated_at`,
    [
      userId,
      next.timezone,
      next.locale,
      next.predictionEnabled,
      next.recommendationsEnabled,
      next.sharedLearningOptIn,
      next.llmOptIn,
      next.recurrenceAutoCreateDefault,
      next.emailRemindersEnabled,
    ],
  );
  if (!updated[0]) throw new Error('Could not update user settings.');
  return toSettings(updated[0]);
}
