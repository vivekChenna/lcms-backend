import nodemailer, { type Transporter } from 'nodemailer';
import type { Env } from '../../../config/env';
import type { Mailer, MailMessage } from './mailer';

export class NodemailerMailer implements Mailer {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(transporter: Transporter, from: string) {
    this.transporter = transporter;
    this.from = from;
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}

export function createMailerFromEnv(env: Env): NodemailerMailer {
  if (!env.SMTP_HOST || !env.MAIL_FROM) {
    throw new Error('SMTP_HOST and MAIL_FROM must be set to enable email notifications');
  }
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER && env.SMTP_PASSWORD ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return new NodemailerMailer(transporter, env.MAIL_FROM);
}
