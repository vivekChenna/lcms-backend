import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseMasterData } from '../../helpers/seed-case';

describe('POST /cases', () => {
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

  async function reset() {
    await resetDatabase(ds);
  }

  it('lets a requester submit an Internal-category case, computing reference number and SLA dates', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    // Migration 1700000003000-create-simple-master-data.ts permanently seeds
    // a real category literally named 'Internal' (alongside Najiz, Baladi
    // Violation, HR Termination). Renaming a freshly-seeded category to
    // 'Internal' (the brief's literal approach) collides with that row's
    // unique-name constraint on every run, fresh container or not — so this
    // test uses the pre-seeded 'Internal' row's own id directly instead, with
    // a case type scoped to it.
    const [internalCategory] = await ds.query(`SELECT id FROM case_categories WHERE name = 'Internal'`);
    const [internalCaseType] = await ds.query(
      `INSERT INTO case_types (id, "categoryId", name, "slaAckHours", "slaResolutionHours") VALUES (gen_random_uuid(), $1, $2, 24, 72) RETURNING id`,
      [internalCategory.id, `Internal-Type-${Date.now()}`],
    );
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId, businessUnitId: master.businessUnitId });
    const token = app.signAccessToken({ id: requesterId, role: 'requester', departmentId: master.departmentId, entityId: master.entityId, businessUnitId: master.businessUnitId });

    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'Need contract review',
        description: 'This case description is definitely at least twenty characters.',
        declarationConfirmed: true,
        categoryId: internalCategory.id,
        caseTypeId: internalCaseType.id,
        departmentId: master.departmentId,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('Submitted');
    // Entity code prefix length varies (seedCaseMasterData derives it from a
    // random UUID slice, widened in the final-review fix wave to shrink
    // collision odds — see decisions/case-core/final-review-fixes.md), so
    // this only pins the fixed caseType/sequence suffix, not the entity code width.
    expect(body.referenceNumber).toMatch(/^E\w{3,}-\w{3}-\d{6}$/);
    expect(body.entityId).toBe(master.entityId);
    expect(body.businessUnitId).toBe(master.businessUnitId);
    expect(new Date(body.ackDueAt).getTime()).toBeGreaterThan(Date.now());

    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'case.submitted'`);
    expect(auditRows).toHaveLength(1);
    await app.close();
  });

  it('rejects a requester submitting a non-Internal category (VC-03)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds); // category name is "Category-xxxxxxxx", not Internal
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const token = app.signAccessToken({ id: requesterId, role: 'requester', departmentId: master.departmentId, entityId: master.entityId, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'x',
        description: 'This case description is definitely at least twenty characters.',
        declarationConfirmed: true,
        categoryId: master.categoryId,
        caseTypeId: master.caseTypeId,
        departmentId: master.departmentId,
      },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('lets a legal_rep submit any category', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep', { entityId: master.entityId });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: master.entityId, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'x',
        description: 'This case description is definitely at least twenty characters.',
        declarationConfirmed: true,
        categoryId: master.categoryId,
        caseTypeId: master.caseTypeId,
        departmentId: master.departmentId,
        entityId: master.entityId,
      },
    });

    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('rejects a caseTypeId that does not belong to the submitted categoryId (VC-04)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const otherMaster = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep', { entityId: master.entityId });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: master.entityId, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'x',
        description: 'This case description is definitely at least twenty characters.',
        declarationConfirmed: true,
        categoryId: master.categoryId,
        caseTypeId: otherMaster.caseTypeId,
        departmentId: master.departmentId,
        entityId: master.entityId,
      },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a businessUnitId that does not belong to the submitted entityId (VC-05)', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const otherMaster = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep', { entityId: master.entityId });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: master.entityId, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'x',
        description: 'This case description is definitely at least twenty characters.',
        declarationConfirmed: true,
        categoryId: master.categoryId,
        caseTypeId: master.caseTypeId,
        departmentId: master.departmentId,
        entityId: master.entityId,
        businessUnitId: otherMaster.businessUnitId,
      },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('auto-assigns when a matching active routing rule exists', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep', { entityId: master.entityId });
    await ds.query(
      `INSERT INTO routing_rules (id, "matchCriteria", "targetLegalRepId", "priorityOrder", "isActive") VALUES (gen_random_uuid(), $1, $2, 1, true)`,
      [JSON.stringify({ categoryId: master.categoryId }), repId],
    );
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: master.entityId, businessUnitId: null });

    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'x',
        description: 'This case description is definitely at least twenty characters.',
        declarationConfirmed: true,
        categoryId: master.categoryId,
        caseTypeId: master.caseTypeId,
        departmentId: master.departmentId,
        entityId: master.entityId,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('Assigned');
    expect(res.json().assignedLegalRepId).toBe(repId);
    const auditRows = await ds.query(`SELECT action FROM audit_log WHERE action = 'case.auto_assigned'`);
    expect(auditRows).toHaveLength(1);
    await app.close();
  });

  it('never produces duplicate reference numbers under concurrent submissions', async () => {
    await reset();
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep', { entityId: master.entityId });
    const token = app.signAccessToken({ id: repId, role: 'legal_rep', departmentId: null, entityId: master.entityId, businessUnitId: null });
    const payload = {
      title: 'x',
      description: 'This case description is definitely at least twenty characters.',
      declarationConfirmed: true,
      categoryId: master.categoryId,
      caseTypeId: master.caseTypeId,
      departmentId: master.departmentId,
      entityId: master.entityId,
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({ method: 'POST', url: '/cases', headers: { authorization: `Bearer ${token}` }, payload }),
      ),
    );

    const refs = results.map((r) => r.json().referenceNumber);
    expect(new Set(refs).size).toBe(5);
    await app.close();
  });
});
