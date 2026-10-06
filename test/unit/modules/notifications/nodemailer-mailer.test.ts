import { describe, it, expect, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { NodemailerMailer, createMailerFromEnv } from '../../../../src/modules/notifications/email/nodemailer-mailer';
import { loadEnv } from '../../../../src/config/env';

const base = { DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 'x'.repeat(32) };

describe('NodemailerMailer', () => {
  it('sends the message with the configured sender', async () => {
    const transporter = nodemailer.createTransport({ jsonTransport: true });
    const sendMail = vi.spyOn(transporter, 'sendMail').mockResolvedValue({} as never);
    const mailer = new NodemailerMailer(transporter, 'lcms@algihaz.example');

    await mailer.send({ to: 'user@algihaz.example', subject: 'Subject line', text: 'Body text' });

    expect(sendMail).toHaveBeenCalledWith({
      from: 'lcms@algihaz.example',
      to: 'user@algihaz.example',
      subject: 'Subject line',
      text: 'Body text',
    });
  });

  it('propagates a transport failure so the dispatcher can retry', async () => {
    const transporter = nodemailer.createTransport({ jsonTransport: true });
    vi.spyOn(transporter, 'sendMail').mockRejectedValue(new Error('connection refused'));
    const mailer = new NodemailerMailer(transporter, 'lcms@algihaz.example');

    await expect(mailer.send({ to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow('connection refused');
  });
});

describe('createMailerFromEnv', () => {
  it('refuses to start without SMTP_HOST or MAIL_FROM', () => {
    expect(() => createMailerFromEnv(loadEnv({ ...base, MAIL_FROM: 'a@b.c' }))).toThrow(/SMTP_HOST and MAIL_FROM/);
    expect(() => createMailerFromEnv(loadEnv({ ...base, SMTP_HOST: 'localhost' }))).toThrow(/SMTP_HOST and MAIL_FROM/);
  });

  it('builds a mailer when both are present', () => {
    const mailer = createMailerFromEnv(loadEnv({ ...base, SMTP_HOST: 'localhost', MAIL_FROM: 'a@b.c' }));
    expect(mailer).toBeInstanceOf(NodemailerMailer);
  });
});
