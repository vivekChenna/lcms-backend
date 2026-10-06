// test/integration/modules/cases/intake-fields.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { authHeader } from '../../helpers/auth-header';

describe('extra intake fields and the confidential flag', () => {
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

  async function internalIds() {
    const [category] = await ds.query(`SELECT id FROM case_categories WHERE name = 'Internal'`);
    const [caseType] = await ds.query(
      `INSERT INTO case_types (id, "categoryId", name, "slaAckHours", "slaResolutionHours") VALUES (gen_random_uuid(), $1, $2, 24, 72) RETURNING id`,
      [category.id, `Internal-Type-${Date.now()}-${Math.random()}`],
    );
    return { categoryId: category.id as string, caseTypeId: caseType.id as string };
  }

  async function requesterWorld() {
    const master = await seedCaseMasterData(ds);
    const ids = await internalIds();
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId, businessUnitId: master.businessUnitId });
    const payload = {
      title: 'Need contract review',
      description: 'This case description is definitely at least twenty characters.',
      declarationConfirmed: true,
      categoryId: ids.categoryId,
      caseTypeId: ids.caseTypeId,
      departmentId: master.departmentId,
    };
    return { master, requesterId, payload };
  }

  it('creates a case with every extra field and returns them', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, payload } = await requesterWorld();

    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      headers: authHeader(app, requesterId, 'requester'),
      payload: {
        ...payload,
        isConfidential: true,
        contactName: 'Omar Al-Zahrani',
        contactEmail: 'omar@algihaz.example',
        contactPhone: '+966 11 000 0000',
        desiredOutcome: 'Renewed agreement with better exit rights.',
        incidentDate: '2026-08-17',
        businessDeadline: '2026-09-28',
        counterparty: 'Zahran Equipment Co.',
        estimatedValue: 8900000.5,
        thirdPartyDetails: 'Contract no. 4471, supplier since 2019.',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      isConfidential: true,
      contactName: 'Omar Al-Zahrani',
      contactEmail: 'omar@algihaz.example',
      contactPhone: '+966 11 000 0000',
      desiredOutcome: 'Renewed agreement with better exit rights.',
      incidentDate: '2026-08-17',
      businessDeadline: '2026-09-28',
      counterparty: 'Zahran Equipment Co.',
      estimatedValue: 8900000.5,
      thirdPartyDetails: 'Contract no. 4471, supplier since 2019.',
    });
    await app.close();
  });

  it('defaults to not confidential with every optional field null', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, payload } = await requesterWorld();

    const res = await app.inject({ method: 'POST', url: '/cases', headers: authHeader(app, requesterId, 'requester'), payload });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      isConfidential: false, contactName: null, contactEmail: null, contactPhone: null, desiredOutcome: null,
      incidentDate: null, businessDeadline: null, counterparty: null, estimatedValue: null, thirdPartyDetails: null,
    });
    await app.close();
  });

  it('treats empty and whitespace-only strings as absent on create', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, payload } = await requesterWorld();

    const res = await app.inject({
      method: 'POST', url: '/cases', headers: authHeader(app, requesterId, 'requester'),
      payload: { ...payload, contactName: '', contactEmail: '   ', counterparty: '' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ contactName: null, contactEmail: null, counterparty: null });
    await app.close();
  });

  it.each([
    ['a bad email', { contactEmail: 'not-an-email' }],
    ['a negative value', { estimatedValue: -1 }],
    ['an impossible date', { incidentDate: '2026-13-45' }],
    ['a non-ISO date', { businessDeadline: '28/09/2026' }],
    ['an over-long description', { desiredOutcome: 'x'.repeat(5001) }],
    ['an over-long contact name', { contactName: 'x'.repeat(201) }],
  ])('rejects %s with 400', async (_label, extra) => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, payload } = await requesterWorld();

    const res = await app.inject({ method: 'POST', url: '/cases', headers: authHeader(app, requesterId, 'requester'), payload: { ...payload, ...extra } });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('PATCH sets, changes and clears the fields while the case is Submitted', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { master, requesterId } = await requesterWorld();
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Submitted' });
    const headers = authHeader(app, requesterId, 'requester');

    const set = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}`, headers, payload: { isConfidential: true, counterparty: 'Acme', estimatedValue: 100 } });
    const clear = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}`, headers, payload: { counterparty: null, estimatedValue: null } });

    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ isConfidential: true, counterparty: 'Acme', estimatedValue: 100 });
    expect(clear.json()).toMatchObject({ isConfidential: true, counterparty: null, estimatedValue: null });
    await app.close();
  });

  it('PATCH is refused once the case has left Submitted (existing rule)', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { master, requesterId } = await requesterWorld();
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'In Progress' });

    const res = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}`, headers: authHeader(app, requesterId, 'requester'), payload: { isConfidential: true } });

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('the edit audit entry records the changed intake fields', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { master, requesterId } = await requesterWorld();
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Submitted' });

    await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}`, headers: authHeader(app, requesterId, 'requester'), payload: { counterparty: 'Acme' } });

    const [row] = await ds.query(`SELECT "beforeValue", "afterValue" FROM audit_log WHERE "caseId" = $1 AND action = 'case.updated'`, [caseRow.id]);
    expect(row.afterValue.counterparty).toBe('Acme');
    expect(row.beforeValue.counterparty).toBeNull();
    await app.close();
  });

  it('rejects an estimatedValue above numeric(14,2) on create and patch, and accepts the maximum', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { master, requesterId, payload } = await requesterWorld();
    const headers = authHeader(app, requesterId, 'requester');

    const tooBig = await app.inject({ method: 'POST', url: '/cases', headers, payload: { ...payload, estimatedValue: 1_000_000_000_000 } });
    expect(tooBig.statusCode).toBe(400);
    const max = await app.inject({ method: 'POST', url: '/cases', headers, payload: { ...payload, estimatedValue: 999_999_999_999.99 } });
    expect(max.statusCode).toBe(201);

    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Submitted' });
    const patchBig = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}`, headers, payload: { estimatedValue: 1_000_000_000_000 } });
    expect(patchBig.statusCode).toBe(400);
    const patchMax = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}`, headers, payload: { estimatedValue: 999_999_999_999.99 } });
    expect(patchMax.statusCode).toBe(200);
    await app.close();
  });

  it('migration columns round-trip through the fixture', async () => {
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });

    const row = await seedCase(ds, { ...master, requesterId, isConfidential: true, counterparty: 'Seeded Co.', estimatedValue: 12.5 });

    expect(row.isConfidential).toBe(true);
    expect(row.counterparty).toBe('Seeded Co.');
    expect(row.estimatedValue).toBe(12.5);
  });
});
