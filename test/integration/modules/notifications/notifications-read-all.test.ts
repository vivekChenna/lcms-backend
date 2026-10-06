import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedNotification } from '../../helpers/seed-notification';
import { authHeader } from '../../helpers/auth-header';

describe('PATCH /notifications/read-all', () => {
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
    await resetDatabase(ds);
  });

  it('marks every unread notification of the caller read and reports the count', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'requester');
    await seedNotification(ds, { userId, title: 'one' });
    await seedNotification(ds, { userId, title: 'two' });
    await seedNotification(ds, { userId, title: 'three' });

    const res = await app.inject({ method: 'PATCH', url: '/notifications/read-all', headers: authHeader(app, userId, 'requester') });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: 3 });
    const list = await app.inject({ method: 'GET', url: '/notifications', headers: authHeader(app, userId, 'requester') });
    expect(list.json().unreadCount).toBe(0);
    expect(list.json().items.every((item: { isRead: boolean; readAt: string | null }) => item.isRead && item.readAt !== null)).toBe(true);
    await app.close();
  });

  it('is idempotent and keeps the first readAt of an already-read notification', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'legal_rep');
    const earlier = new Date('2026-01-01T10:00:00Z');
    await seedNotification(ds, { userId, title: 'already read', isRead: true, readAt: earlier });
    await seedNotification(ds, { userId, title: 'unread' });
    const headers = authHeader(app, userId, 'legal_rep');

    const first = await app.inject({ method: 'PATCH', url: '/notifications/read-all', headers });
    const second = await app.inject({ method: 'PATCH', url: '/notifications/read-all', headers });

    expect(first.json()).toEqual({ updated: 1 });
    expect(second.json()).toEqual({ updated: 0 });
    const [row] = await ds.query(`SELECT "readAt" FROM notifications WHERE title = 'already read'`);
    expect(new Date(row.readAt).toISOString()).toBe(earlier.toISOString());
    await app.close();
  });

  it('never touches another user\'s notifications', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'requester');
    const otherId = await seedUserWithRole(ds, 'requester');
    await seedNotification(ds, { userId, title: 'mine' });
    await seedNotification(ds, { userId: otherId, title: 'theirs' });

    await app.inject({ method: 'PATCH', url: '/notifications/read-all', headers: authHeader(app, userId, 'requester') });

    const [theirs] = await ds.query(`SELECT "isRead" FROM notifications WHERE title = 'theirs'`);
    expect(theirs.isRead).toBe(false);
    await app.close();
  });

  it('works with nothing to mark, for a viewer, and requires authentication', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const viewerId = await seedUserWithRole(ds, 'viewer');

    const empty = await app.inject({ method: 'PATCH', url: '/notifications/read-all', headers: authHeader(app, viewerId, 'viewer') });
    const anonymous = await app.inject({ method: 'PATCH', url: '/notifications/read-all' });

    expect(empty.json()).toEqual({ updated: 0 });
    expect(anonymous.statusCode).toBe(401);
    await app.close();
  });
});
