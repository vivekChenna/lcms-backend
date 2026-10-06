import type { Mailer, MailMessage } from '../../../src/modules/notifications/email/mailer';

export class RecordingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  maxInFlight = 0;
  private inFlight = 0;
  private failuresRemaining = 0;
  private alwaysFail = false;
  private delayMs = 0;

  failNext(count: number): void {
    this.failuresRemaining = count;
  }

  failAlways(): void {
    this.alwaysFail = true;
  }

  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  async send(message: MailMessage): Promise<void> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      if (this.alwaysFail) {
        throw new Error('SMTP unavailable');
      }
      if (this.failuresRemaining > 0) {
        this.failuresRemaining -= 1;
        throw new Error('SMTP unavailable');
      }
      this.sent.push(message);
    } finally {
      this.inFlight -= 1;
    }
  }
}
