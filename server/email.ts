import { randomUUID } from 'node:crypto';
import { getDb } from './db/client.ts';

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  /** Template name recorded in email_outbox for auditing. */
  template: string;
  userId?: string | null;
  /** Non-sensitive metadata; never put raw tokens in here. */
  payload?: Record<string, unknown>;
}

export interface SendEmailResult {
  /** True when a real provider accepted the message. */
  delivered: boolean;
  /** Link printed by the development sender, if any. */
  mode: 'resend' | 'console';
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Queue an email in `email_outbox` and try to deliver it.
 *
 * Delivery is optional while no provider is configured: without
 * `RESEND_API_KEY` the message is printed to the server log instead. This keeps
 * local development and the test suite fully functional without a vendor.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const db = await getDb();
  const id = randomUUID();
  await db.query(
    `insert into email_outbox
       (id, user_id, to_email, template, payload, status)
     values ($1, $2, $3, $4, $5::jsonb, 'pending')`,
    [
      id,
      input.userId ?? null,
      input.to,
      input.template,
      JSON.stringify(input.payload ?? {}),
    ],
  );

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    // Development delivery: useful in the terminal, harmless in production.
    console.log(
      `\n[email:${input.template}] to ${input.to}\n${input.subject}\n${input.text}\n`,
    );
    await db.query(
      `update email_outbox
          set status = 'sent', sent_at = now(), last_error = 'dev-console'
        where id = $1`,
      [id],
    );
    return { delivered: false, mode: 'console' };
  }

  const from =
    process.env.TODO_EMAIL_FROM?.trim() || 'To-Do <no-reply@example.com>';
  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Resend responded ${response.status}: ${detail}`);
    }
    await db.query(
      `update email_outbox
          set status = 'sent', sent_at = now(), attempts = attempts + 1
        where id = $1`,
      [id],
    );
    return { delivered: true, mode: 'resend' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.query(
      `update email_outbox
          set status = 'failed', attempts = attempts + 1, last_error = $2
        where id = $1`,
      [id, message.slice(0, 500)],
    );
    console.error(`Email delivery failed for ${input.to}: ${message}`);
    return { delivered: false, mode: 'resend' };
  }
}
