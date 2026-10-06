import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../../src/config/env';
import { createMailerFromEnv } from '../../../src/modules/notifications/email/nodemailer-mailer';

// Opt-in: runs only against the dev MailHog (docker-compose.dev.yml).
//   docker compose -f docker-compose.dev.yml up -d mailhog
//   MAILHOG_SMOKE_TEST=1 npx vitest run test/integration/email
const enabled = process.env.MAILHOG_SMOKE_TEST === '1';

describe.skipIf(!enabled)('NodemailerMailer against MailHog', () => {
  it('delivers a message that MailHog can read back', async () => {
    const mailer = createMailerFromEnv(
      loadEnv({
        DATABASE_URL: 'postgres://x',
        JWT_ACCESS_SECRET: 'x'.repeat(32),
        SMTP_HOST: 'localhost',
        SMTP_PORT: '1025',
        MAIL_FROM: 'lcms@algihaz.local',
      }),
    );
    const subject = `LCMS smoke ${Date.now()}`;

    await mailer.send({ to: 'smoke@algihaz.local', subject, text: 'Hello from the smoke test' });

    const response = await fetch('http://localhost:8025/api/v2/messages');
    const body = (await response.json()) as { items: Array<{ Content: { Headers: { Subject: string[] } } }> };
    expect(body.items.some((item) => item.Content.Headers.Subject.includes(subject))).toBe(true);
  });
});
