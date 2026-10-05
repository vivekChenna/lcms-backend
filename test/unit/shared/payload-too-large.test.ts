import { describe, it, expect } from 'vitest';
import { PayloadTooLargeError, AppError } from '../../../src/shared/errors';

describe('PayloadTooLargeError', () => {
  it('is an AppError mapped to 413', () => {
    const err = new PayloadTooLargeError('too big');
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(413);
    expect(err.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
