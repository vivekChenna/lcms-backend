import { describe, it, expect } from 'vitest';
import { RecordingMailer } from '../../integration/helpers/recording-mailer';

const message = (subject: string) => ({ to: 'a@b.c', subject, text: 't' });

describe('RecordingMailer', () => {
  it('records sent messages in order', async () => {
    const mailer = new RecordingMailer();
    await mailer.send(message('one'));
    await mailer.send(message('two'));
    expect(mailer.sent.map((m) => m.subject)).toEqual(['one', 'two']);
  });

  it('fails the next N sends and then recovers', async () => {
    const mailer = new RecordingMailer();
    mailer.failNext(2);
    await expect(mailer.send(message('a'))).rejects.toThrow('SMTP unavailable');
    await expect(mailer.send(message('b'))).rejects.toThrow('SMTP unavailable');
    await mailer.send(message('c'));
    expect(mailer.sent.map((m) => m.subject)).toEqual(['c']);
  });

  it('can fail forever', async () => {
    const mailer = new RecordingMailer();
    mailer.failAlways();
    await expect(mailer.send(message('a'))).rejects.toThrow('SMTP unavailable');
    await expect(mailer.send(message('b'))).rejects.toThrow('SMTP unavailable');
    expect(mailer.sent).toHaveLength(0);
  });

  it('tracks the highest number of overlapping sends when a delay is set', async () => {
    const mailer = new RecordingMailer();
    mailer.setDelay(30);
    await Promise.all([mailer.send(message('a')), mailer.send(message('b'))]);
    expect(mailer.maxInFlight).toBe(2);
    expect(mailer.sent).toHaveLength(2);
  });
});
