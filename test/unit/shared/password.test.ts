import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../../src/shared/password';

describe('password hashing', () => {
  it('verifies a correct password against its hash', async () => {
    const hash = await hashPassword('Sup3rSecret!');
    await expect(verifyPassword(hash, 'Sup3rSecret!')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('Sup3rSecret!');
    await expect(verifyPassword(hash, 'wrong')).resolves.toBe(false);
  });

  it('never stores the plaintext password in the hash output', async () => {
    const hash = await hashPassword('Sup3rSecret!');
    expect(hash).not.toContain('Sup3rSecret!');
  });
});
