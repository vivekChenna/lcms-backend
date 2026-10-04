import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { seedAdmin } from '../../../../src/db/seed-admin';
import { login, refreshSession } from '../../../../src/modules/auth/auth.service';

describe('POST /auth/refresh', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM refresh_tokens');
    await ds.query('DELETE FROM user_roles');
    await ds.query('DELETE FROM users');
  });

  it('issues a new token pair for a valid refresh token', async () => {
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'Correct123!' });
    const app = buildTestApp(ds);
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@lcms.local', password: 'Correct123!' },
    });
    const { refreshToken } = login.json();

    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });

    expect(res.statusCode).toBe(200);
    expect(res.json().refreshToken).not.toBe(refreshToken);

    await app.close();
  });

  it('rejects reuse of an already-rotated refresh token (replay protection)', async () => {
    await seedAdmin(ds, { email: 'admin@lcms.local', password: 'Correct123!' });
    const app = buildTestApp(ds);
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@lcms.local', password: 'Correct123!' },
    });
    const { refreshToken } = login.json();

    await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    const replay = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });

    expect(replay.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an unknown refresh token', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: 'not-a-real-token' } });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  // 20 serial rounds each pay bcryptjs's cost-12 hash (~320ms) + compare
  // (~380ms) — pure-JS bcrypt, not the native binding, so this is slow by
  // construction. That's ~14s of bcrypt alone against the suite's global
  // 15s testTimeout, leaving ~1s of margin for this round's DB work before
  // it intermittently times out under any extra load (a busy shared test
  // container, CPU contention). Root-caused via direct measurement on this
  // machine (2026-10-04); the replay-protection logic itself isn't at
  // fault. Local override, not a global testTimeout change, since no other
  // test in the suite does this much serial bcrypt work.
  it('rejects concurrent replay at the service level — exactly one of N simultaneous refreshes with the same token succeeds (code review finding, matches reviewer repro: N=5, 20 rounds)', async () => {
    for (let round = 0; round < 20; round += 1) {
      await seedAdmin(ds, { email: `admin-round-${round}@lcms.local`, password: 'Correct123!' });
      const { refreshToken } = await login(ds, 30, `admin-round-${round}@lcms.local`, 'Correct123!');

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => refreshSession(ds, 30, refreshToken)),
      );
      const succeeded = results.filter((r) => r.status === 'fulfilled');

      expect(succeeded).toHaveLength(1);
    }
  }, 30000);
});
