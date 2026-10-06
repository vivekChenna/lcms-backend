import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedNotification } from '../../helpers/seed-notification';
import { authHeader } from '../../helpers/auth-header';

describe('GET /notifications and PATCH /notifications/:id/read', () => {
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

  const ago = (ms: number) => new Date(Date.now() - ms);

  it('lists only the caller\'s notifications, newest first, with the unread count', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'requester');
    const otherId = await seedUserWithRole(ds, 'requester');
    const { caseRow } = await seedCaseWithParties(ds);
    await seedNotification(ds, { userId, title: 'oldest', createdAt: ago(3000), isRead: true, readAt: ago(1000) });
    await seedNotification(ds, { userId, title: 'middle', createdAt: ago(2000), relatedCaseId: caseRow.id });
    await seedNotification(ds, { userId, title: 'newest', createdAt: ago(1000) });
    await seedNotification(ds, { userId: otherId, title: 'not mine' });

    const res = await app.inject({ method: 'GET', url: '/notifications', headers: authHeader(app, userId, 'requester') });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((item: { title: string }) => item.title)).toEqual(['newest', 'middle', 'oldest']);
    expect(body).toMatchObject({ total: 3, page: 1, pageSize: 20, unreadCount: 2 });
    const middle = body.items[1];
    expect(middle).toMatchObject({ type: 'case.registered', relatedCaseId: caseRow.id, isRead: false, readAt: null });
    expect(typeof middle.createdAt).toBe('string');
    expect(middle).not.toHaveProperty('emailStatus');
    expect(middle).not.toHaveProperty('userId');
    await app.close();
  });

  it('filters by isRead while unreadCount still reflects every unread notification', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'legal_rep');
    await seedNotification(ds, { userId, title: 'read one', isRead: true, readAt: new Date() });
    await seedNotification(ds, { userId, title: 'unread one' });
    await seedNotification(ds, { userId, title: 'unread two' });

    const unread = await app.inject({ method: 'GET', url: '/notifications?isRead=false', headers: authHeader(app, userId, 'legal_rep') });
    const read = await app.inject({ method: 'GET', url: '/notifications?isRead=true', headers: authHeader(app, userId, 'legal_rep') });

    expect(unread.json().total).toBe(2);
    expect(unread.json().unreadCount).toBe(2);
    expect(read.json().items.map((item: { title: string }) => item.title)).toEqual(['read one']);
    expect(read.json().total).toBe(1);
    expect(read.json().unreadCount).toBe(2);
    await app.close();
  });

  it('paginates', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'admin');
    for (let i = 0; i < 5; i += 1) {
      await seedNotification(ds, { userId, title: `n${i}`, createdAt: ago((5 - i) * 1000) });
    }

    const page2 = await app.inject({ method: 'GET', url: '/notifications?page=2&pageSize=2', headers: authHeader(app, userId, 'admin') });

    expect(page2.json().items.map((item: { title: string }) => item.title)).toEqual(['n2', 'n1']);
    expect(page2.json()).toMatchObject({ total: 5, page: 2, pageSize: 2, unreadCount: 5 });
    await app.close();
  });

  it('rejects an invalid isRead value or page size with 400', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'requester');

    const badFlag = await app.inject({ method: 'GET', url: '/notifications?isRead=maybe', headers: authHeader(app, userId, 'requester') });
    const badSize = await app.inject({ method: 'GET', url: '/notifications?pageSize=1000', headers: authHeader(app, userId, 'requester') });

    expect(badFlag.statusCode).toBe(400);
    expect(badSize.statusCode).toBe(400);
    await app.close();
  });

  it('requires authentication', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/notifications' });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('marks a notification read once: readAt is set and a second call leaves it unchanged', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'requester');
    const notification = await seedNotification(ds, { userId });

    const first = await app.inject({ method: 'PATCH', url: `/notifications/${notification.id}/read`, headers: authHeader(app, userId, 'requester') });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await app.inject({ method: 'PATCH', url: `/notifications/${notification.id}/read`, headers: authHeader(app, userId, 'requester') });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: notification.id, isRead: true });
    expect(first.json().readAt).not.toBeNull();
    expect(second.statusCode).toBe(200);
    expect(second.json().readAt).toBe(first.json().readAt);
    await app.close();
  });

  it('returns 404 for another user\'s notification and for an unknown id', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'requester');
    const otherId = await seedUserWithRole(ds, 'requester');
    const notification = await seedNotification(ds, { userId });

    const foreign = await app.inject({ method: 'PATCH', url: `/notifications/${notification.id}/read`, headers: authHeader(app, otherId, 'requester') });
    const unknown = await app.inject({ method: 'PATCH', url: '/notifications/6f1d2c4a-8b3e-4a7d-9c5f-0e1a2b3c4d5e/read', headers: authHeader(app, userId, 'requester') });

    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    const [row] = await ds.query(`SELECT "isRead" FROM notifications WHERE id = $1`, [notification.id]);
    expect(row.isRead).toBe(false);
    await app.close();
  });

  it('lets a viewer list and mark their own notifications read', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const viewerId = await seedUserWithRole(ds, 'viewer');
    const notification = await seedNotification(ds, { userId: viewerId });

    const list = await app.inject({ method: 'GET', url: '/notifications', headers: authHeader(app, viewerId, 'viewer') });
    const read = await app.inject({ method: 'PATCH', url: `/notifications/${notification.id}/read`, headers: authHeader(app, viewerId, 'viewer') });

    expect(list.statusCode).toBe(200);
    expect(read.statusCode).toBe(200);
    await app.close();
  });
});
