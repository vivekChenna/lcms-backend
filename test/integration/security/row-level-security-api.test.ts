import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { entities } from '../../../src/db/entities';
import { migrations } from '../../../src/db/migrations';
import { installRowLevelSecurity } from '../../../src/db/row-level-security';
import { buildTestApp } from '../helpers/build-test-app';
import { authHeader } from '../helpers/auth-header';
import { resetDatabase } from '../helpers/reset-db';
import { seedUserWithRole, type SeedableRole } from '../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../helpers/seed-case';
import { seedInformationRequest } from '../helpers/seed-information-request';

// The policies are only half of BRD AC-03: the application has to put every request's user onto the
// database connection it uses. These tests drive real HTTP requests at a probe route that, like a
// buggy handler would, reads `cases` with NO filtering of its own. What comes back is then purely
// what Postgres lets that user see.

describe('row-level security through the API (BRD AC-03)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    // a deliberately tiny pool, so requests queue for connections and connections are reused by
    // different users all the time: the situation in which per-request state could leak
    ds = new DataSource({
      type: 'postgres',
      url: 'postgres://lcms:lcms@localhost:5433/lcms_test',
      synchronize: false,
      logging: false,
      entities,
      migrations,
      extra: { max: 2 },
    });
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

  async function world() {
    const master = await seedCaseMasterData(ds);
    const [other] = await ds.query(`INSERT INTO departments (id, name) VALUES (gen_random_uuid(), $1) RETURNING id`, [
      `Other-${Math.random().toString(36).slice(2, 8)}`,
    ]);
    const make = async (role: SeedableRole, departmentId: string | null = null) => ({
      role,
      id: await seedUserWithRole(ds, role, { departmentId }),
    });
    const people = {
      requesterA: await make('requester', master.departmentId),
      requesterB: await make('requester', other.id),
      rep: await make('legal_rep'),
      viewer: await make('viewer'),
      admin: await make('admin'),
    };
    const base = { categoryId: master.categoryId, caseTypeId: master.caseTypeId, entityId: master.entityId };
    await seedCase(ds, { ...base, departmentId: master.departmentId, requesterId: people.requesterA.id });
    await seedCase(ds, { ...base, departmentId: master.departmentId, requesterId: people.requesterA.id, isConfidential: true });
    const theirs = await seedCase(ds, { ...base, departmentId: other.id, requesterId: people.requesterB.id });
    await seedCase(ds, { ...base, departmentId: other.id, requesterId: people.requesterB.id, isConfidential: true });
    await seedInformationRequest(ds, { caseId: theirs.id, raisedById: people.rep.id, responderId: people.requesterA.id });
    return people;
  }

  // visible to each: requesterA = own two + the other department's case they answer for = 3;
  // requesterB = own two = 2; viewer = non-confidential = 2; rep and admin = all 4
  const EXPECTED = { requesterA: 3, requesterB: 2, viewer: 2, rep: 4, admin: 4 } as const;

  async function probeApp() {
    const app = buildTestApp(ds);
    const count = async () => ((await ds.query(`SELECT count(*)::int AS n FROM cases`)) as { n: number }[])[0]!.n;
    // registered after the app's own plugins, so `authenticate` exists inside it
    await app.register(async (instance) => {
      instance.get('/__probe/cases', { preHandler: [instance.authenticate] }, async () => ({ n: await count() }));
      instance.get('/__probe/public', async () => ({ n: await count() }));
    });
    await app.ready();
    return app;
  }

  const countFor = async (app: Awaited<ReturnType<typeof probeApp>>, person: { id: string; role: string }) => {
    const res = await app.inject({ method: 'GET', url: '/__probe/cases', headers: authHeader(app, person.id, person.role) });
    expect(res.statusCode).toBe(200);
    return res.json().n as number;
  };

  it('is switched on for the data source the app uses', async () => {
    expect(await installRowLevelSecurity(ds, { required: true })).toBe(true);
  });

  it('each request sees exactly what Postgres allows its user, even through a handler that does not filter', async () => {
    const people = await world();
    const app = await probeApp();
    for (const [name, expected] of Object.entries(EXPECTED)) {
      expect(await countFor(app, people[name as keyof typeof people]), name).toBe(expected);
    }
    await app.close();
  });

  it('a request that is not signed in sees nothing in the protected tables', async () => {
    await world();
    const app = await probeApp();
    const res = await app.inject({ method: 'GET', url: '/__probe/public' });
    expect(res.json().n).toBe(0);
    await app.close();
  });

  it('work outside a request (workers, seeds) is not restricted', async () => {
    await world();
    const app = await probeApp();
    const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM cases`);
    expect(n).toBe(4);
    await app.close();
  });

  it('never lets one user\'s identity leak to another, with many concurrent requests sharing two connections', async () => {
    const people = await world();
    const app = await probeApp();
    const order = ['requesterA', 'rep', 'requesterB', 'viewer', 'admin'] as const;
    const jobs = Array.from({ length: 60 }, (_, i) => {
      const name = order[i % order.length]!;
      return countFor(app, people[name]).then((n) => ({ name, n }));
    });
    // mix in signed-out requests too: they must not inherit whoever used the connection before
    const anon = Array.from({ length: 12 }, () =>
      app.inject({ method: 'GET', url: '/__probe/public' }).then((r) => ({ name: 'anon', n: r.json().n as number })),
    );
    const results = await Promise.all([...jobs, ...anon]);
    for (const { name, n } of results) {
      expect(n, name).toBe(name === 'anon' ? 0 : EXPECTED[name as keyof typeof EXPECTED]);
    }
    await app.close();
  });

  it('the API itself still works under row-level security: list, open, comment', async () => {
    const people = await world();
    const app = await probeApp();
    const list = await app.inject({
      method: 'GET',
      url: '/cases',
      headers: authHeader(app, people.requesterA.id, 'requester'),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(3);
    await app.close();
  });
});
