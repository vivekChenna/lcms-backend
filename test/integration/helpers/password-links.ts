import type { RecordingMailer } from './recording-mailer';

/** Pulls the one-time token out of the most recent password email sent to `to`. */
export function tokenFromEmail(mailer: RecordingMailer, to: string): string {
  const message = [...mailer.sent].reverse().find((m) => m.to === to);
  if (!message) throw new Error(`no email was sent to ${to}`);
  const match = /\/set-password\?token=([0-9a-f]{64})/.exec(message.text);
  if (!match?.[1]) throw new Error(`no password link in the email to ${to}: ${message.text}`);
  return match[1];
}
