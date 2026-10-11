import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../helpers/test-data-source';
import { resetDatabase } from '../helpers/reset-db';
import { seedUserWithRole } from '../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../helpers/seed-case';
import { seedComment } from '../helpers/seed-comment';
import { seedDocument } from '../helpers/seed-document';
import { seedInformationRequest } from '../helpers/seed-information-request';

// BRD AC-03: the access rules are enforced by Postgres itself. These tests talk to the database
// directly, as the restricted role, with no application code in between: if a policy is wrong or
// missing the rows leak here no matter what the API does.

type Query = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

describe('row-level security (BRD AC-03)', () => {
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

  /** Run `fn` as the restricted role acting as `userId`, in a transaction that is always rolled back. */
  async function asUser<T>(userId: string | null, fn: (query: Query) => Promise<T>): Promise<T> {
    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(`SET LOCAL ROLE lcms_app`);
      await runner.query(`SELECT set_config('app.user_id', $1, true)`, [userId ?? '']);
      return await fn(async (sql, params) => {
        const result = (await runner.query(sql, params)) as unknown;
        // UPDATE/DELETE ... RETURNING comes back from TypeORM as [rows, affectedCount]
        return (Array.isArray(result) && typeof result[1] === 'number' ? result[0] : result) as Record<string, unknown>[];
      });
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  }

  async function world() {
    const master = await seedCaseMasterData(ds);
    const [otherDepartment] = await ds.query(
      `INSERT INTO departments (id, name) VALUES (gen_random_uuid(), $1) RETURNING id`,
      [`Other-${Math.random().toString(36).slice(2, 8)}`],
    );
    const deptA = master.departmentId as string;
    const deptB = otherDepartment.id as string;

    const requesterA = await seedUserWithRole(ds, 'requester', { departmentId: deptA });
    const requesterA2 = await seedUserWithRole(ds, 'requester', { departmentId: deptA });
    const requesterB = await seedUserWithRole(ds, 'requester', { departmentId: deptB });
    const rep = await seedUserWithRole(ds, 'legal_rep');
    const manager = await seedUserWithRole(ds, 'legal_manager');
    const admin = await seedUserWithRole(ds, 'admin');
    const viewer = await seedUserWithRole(ds, 'viewer');

    const base = { categoryId: master.categoryId, caseTypeId: master.caseTypeId, entityId: master.entityId };
    const own = await seedCase(ds, { ...base, departmentId: deptA, requesterId: requesterA, title: 'own' });
    const deptPublic = await seedCase(ds, { ...base, departmentId: deptA, requesterId: requesterA2, title: 'dept public' });
    const deptSecret = await seedCase(ds, {
      ...base,
      departmentId: deptA,
      requesterId: requesterA2,
      isConfidential: true,
      title: 'dept confidential',
    });
    const otherPublic = await seedCase(ds, { ...base, departmentId: deptB, requesterId: requesterB, title: 'other public' });
    const otherSecret = await seedCase(ds, {
      ...base,
      departmentId: deptB,
      requesterId: requesterB,
      isConfidential: true,
      title: 'other confidential',
    });
    // requesterA is asked for information on a confidential case of another department
    await seedInformationRequest(ds, { caseId: otherSecret.id, raisedById: rep, responderId: requesterA });

    return {
      users: { requesterA, requesterA2, requesterB, rep, manager, admin, viewer },
      cases: { own, deptPublic, deptSecret, otherPublic, otherSecret },
    };
  }

  const titles = async (query: Query) =>
    ((await query(`SELECT title FROM cases ORDER BY title`)) as { title: string }[]).map((r) => r.title);

  describe('cases', () => {
    it('a requester sees their own cases, their department\'s non-confidential cases, and cases they answer for', async () => {
      const { users } = await world();
      expect(await asUser(users.requesterA, titles)).toEqual(['dept public', 'other confidential', 'own']);
    });

    it('a requester does not see another department, nor a confidential case that is not theirs', async () => {
      const { users } = await world();
      // requesterB: only their own two cases; nothing of department A
      expect(await asUser(users.requesterB, titles)).toEqual(['other confidential', 'other public']);
      // requesterA2 sees their own confidential case and the department's public ones
      expect(await asUser(users.requesterA2, titles)).toEqual(['dept confidential', 'dept public', 'own']);
    });

    it('legal representatives, managers and admins see every case', async () => {
      const { users } = await world();
      for (const id of [users.rep, users.manager, users.admin]) {
        expect(await asUser(id, titles)).toEqual([
          'dept confidential',
          'dept public',
          'other confidential',
          'other public',
          'own',
        ]);
      }
    });

    it('a viewer sees every case that is not confidential', async () => {
      const { users } = await world();
      expect(await asUser(users.viewer, titles)).toEqual(['dept public', 'other public', 'own']);
    });

    it('nobody is the default: no user, an unknown user and a deactivated user all see nothing', async () => {
      const { users } = await world();
      const deactivated = await seedUserWithRole(ds, 'admin', { isActive: false });
      expect(await asUser(null, titles)).toEqual([]);
      expect(await asUser('00000000-0000-4000-8000-000000000000', titles)).toEqual([]);
      expect(await asUser(deactivated, titles)).toEqual([]);
      expect(await asUser(users.admin, titles)).toHaveLength(5);
    });

    it('a single row looked up by id is hidden too, not just lists', async () => {
      const { users, cases } = await world();
      const rows = await asUser(users.requesterB, (q) => q(`SELECT id FROM cases WHERE id = $1`, [cases.deptPublic.id]));
      expect(rows).toEqual([]);
    });

    it('a viewer cannot change anything, a requester cannot change a case they cannot see', async () => {
      const { users, cases } = await world();
      // a viewer can see the row, so the change is refused outright rather than matching nothing
      await expect(
        asUser(users.viewer, (q) => q(`UPDATE cases SET title = 'hacked' WHERE id = $1 RETURNING id`, [cases.own.id])),
      ).rejects.toThrow(/row-level security/);
      const strangerUpdate = await asUser(users.requesterB, (q) =>
        q(`UPDATE cases SET title = 'hacked' WHERE id = $1 RETURNING id`, [cases.deptPublic.id]),
      );
      expect(strangerUpdate).toEqual([]);
      // the same statement works for someone allowed to
      const allowed = await asUser(users.manager, (q) =>
        q(`UPDATE cases SET title = 'fine' WHERE id = $1 RETURNING id`, [cases.own.id]),
      );
      expect(allowed).toHaveLength(1);
    });

    it('a viewer cannot create a case; a requester can create their own', async () => {
      const { users, cases } = await world();
      const insert = (requesterId: string) => (q: Query) =>
        q(
          `INSERT INTO cases ("referenceNumber", title, description, "declarationConfirmed", "categoryId", "caseTypeId",
              "departmentId", "entityId", priority, status, "requesterId", "ackDueAt", "resolutionDueAt")
           SELECT 'RLS-' || substr(gen_random_uuid()::text, 1, 6), 't', 'a long enough description for the case', true,
              "categoryId", "caseTypeId", "departmentId", "entityId", 'P3', 'Submitted', $1, now(), now()
           FROM cases WHERE id = $2 RETURNING id`,
          [requesterId, cases.own.id],
        );
      await expect(asUser(users.viewer, insert(users.viewer))).rejects.toThrow(/row-level security/);
      // requesterA copies the department/category of their own case: the new row is theirs, so it is allowed
      await expect(asUser(users.requesterA, async (q) => (await insert(users.requesterA)(q)).length)).resolves.toBe(1);
    });

    it('a requester cannot hand a case to someone else by inserting it under another requester', async () => {
      const { users, cases } = await world();
      const insertAs = (actor: string, requesterId: string) =>
        asUser(actor, (q) =>
          q(
            `INSERT INTO cases ("referenceNumber", title, description, "declarationConfirmed", "categoryId", "caseTypeId",
                "departmentId", "entityId", priority, status, "requesterId", "isConfidential", "ackDueAt", "resolutionDueAt")
             SELECT 'RLS-' || substr(gen_random_uuid()::text, 1, 6), 't', 'a long enough description for the case', true,
                "categoryId", "caseTypeId", $3, "entityId", 'P3', 'Submitted', $1, true, now(), now()
             FROM cases WHERE id = $2 RETURNING id`,
            [requesterId, cases.own.id, cases.otherPublic.departmentId],
          ),
        );
      // a confidential case in another department, owned by someone else: not visible to requesterA
      await expect(insertAs(users.requesterA, users.requesterB)).rejects.toThrow(/row-level security/);
    });
  });

  describe('rows that belong to a case', () => {
    it('documents, information requests and comments follow the case', async () => {
      const { users, cases } = await world();
      await seedDocument(ds, { caseId: cases.deptSecret.id, uploaderId: users.rep, filename: 'secret.pdf' });
      await seedDocument(ds, { caseId: cases.own.id, uploaderId: users.rep, filename: 'open.pdf' });
      await seedComment(ds, { caseId: cases.deptSecret.id, authorId: users.rep, body: 'secret comment' });
      await seedComment(ds, { caseId: cases.own.id, authorId: users.rep, body: 'open comment' });

      const names = (query: Query) =>
        query(`SELECT filename FROM documents ORDER BY filename`).then((r) => r.map((x) => x.filename));
      const bodies = (query: Query) =>
        query(`SELECT body FROM comments ORDER BY body`).then((r) => r.map((x) => x.body));

      // requesterA cannot see the confidential case of their department, so nothing attached to it either
      expect(await asUser(users.requesterA, names)).toEqual(['open.pdf']);
      expect(await asUser(users.requesterA, bodies)).toEqual(['open comment']);
      expect(await asUser(users.rep, names)).toEqual(['open.pdf', 'secret.pdf']);
      expect(await asUser(users.rep, bodies)).toEqual(['open comment', 'secret comment']);
      expect(await asUser(users.requesterB, names)).toEqual([]);
    });

    it('the responder of an information request sees it, and its case, even in another department', async () => {
      const { users } = await world();
      const subjects = (query: Query) =>
        query(`SELECT subject FROM information_requests`).then((r) => r.map((x) => x.subject));
      expect(await asUser(users.requesterA, subjects)).toHaveLength(1);
      expect(await asUser(users.requesterA2, subjects)).toEqual([]);
    });

    it('internal comments are for legal staff only (AC-10)', async () => {
      const { users, cases } = await world();
      await seedComment(ds, { caseId: cases.own.id, authorId: users.rep, body: 'public', isInternal: false });
      await seedComment(ds, { caseId: cases.own.id, authorId: users.rep, body: 'internal', isInternal: true });
      const bodies = (query: Query) => query(`SELECT body FROM comments ORDER BY body`).then((r) => r.map((x) => x.body));

      expect(await asUser(users.requesterA, bodies)).toEqual(['public']);
      expect(await asUser(users.viewer, bodies)).toEqual(['public']);
      expect(await asUser(users.rep, bodies)).toEqual(['internal', 'public']);
      expect(await asUser(users.manager, bodies)).toEqual(['internal', 'public']);
    });

    it('a requester cannot post an internal note, nor comment on a case they cannot see', async () => {
      const { users, cases } = await world();
      const insert = (actor: string, caseId: string, internal: boolean) =>
        asUser(actor, (q) =>
          q(`INSERT INTO comments ("caseId", "authorId", body, "isInternal") VALUES ($1, $2, 'x', $3) RETURNING id`, [
            caseId,
            actor,
            internal,
          ]),
        );
      await expect(insert(users.requesterA, cases.own.id, true)).rejects.toThrow(/row-level security/);
      await expect(insert(users.requesterB, cases.own.id, false)).rejects.toThrow(/row-level security/);
      await expect(insert(users.viewer, cases.own.id, false)).rejects.toThrow(/row-level security/);
      await expect(insert(users.requesterA, cases.own.id, false)).resolves.toHaveLength(1);
      await expect(insert(users.rep, cases.own.id, true)).resolves.toHaveLength(1);
    });
  });

  describe('audit log', () => {
    async function seedAudit(caseId: string | null, actorId: string, action: string) {
      await ds.query(`INSERT INTO audit_log ("caseId", "actorId", action) VALUES ($1, $2, $3)`, [caseId, actorId, action]);
    }
    const actions = (query: Query) => query(`SELECT action FROM audit_log ORDER BY action`).then((r) => r.map((x) => x.action));

    it('is readable with its case, and account-level entries only by managers and admins', async () => {
      const { users, cases } = await world();
      await seedAudit(cases.own.id, users.rep, 'case.assigned');
      await seedAudit(cases.deptSecret.id, users.rep, 'case.secret_thing');
      await seedAudit(null, users.admin, 'user.created');

      expect(await asUser(users.requesterA, actions)).toEqual(['case.assigned']);
      expect(await asUser(users.manager, actions)).toEqual(['case.assigned', 'case.secret_thing', 'user.created']);
      expect(await asUser(users.admin, actions)).toEqual(['case.assigned', 'case.secret_thing', 'user.created']);
      expect(await asUser(users.rep, actions)).toEqual(['case.assigned', 'case.secret_thing']);
    });

    it('a person always sees their own entries', async () => {
      const { users } = await world();
      await seedAudit(null, users.requesterA, 'user.password_set');
      expect(await asUser(users.requesterA, actions)).toEqual(['user.password_set']);
      expect(await asUser(users.requesterB, actions)).toEqual([]);
    });

    it('can be appended to by anyone but never changed or removed, even by an admin', async () => {
      const { users, cases } = await world();
      await seedAudit(cases.own.id, users.rep, 'case.assigned');
      await expect(
        asUser(null, (q) => q(`INSERT INTO audit_log ("actorId", action) VALUES ($1, 'user.password_set')`, [users.requesterA])),
      ).resolves.toBeDefined();
      await expect(asUser(users.admin, (q) => q(`UPDATE audit_log SET action = 'x'`))).rejects.toThrow(/permission denied/);
      await expect(asUser(users.admin, (q) => q(`DELETE FROM audit_log`))).rejects.toThrow(/permission denied/);
    });
  });

  describe('the policies cannot be talked around', () => {
    it('setting other session values does not change what a user may see', async () => {
      const { users } = await world();
      const seen = await asUser(users.requesterB, async (q) => {
        // a request that tries to claim a role or department through settings has no effect
        await q(`SELECT set_config('app.role', 'admin', true), set_config('app.department_id', 'x', true)`);
        return titles(q);
      });
      expect(seen).toEqual(['other confidential', 'other public']);
    });

    it('the restricted role cannot read the migration bookkeeping', async () => {
      const { users } = await world();
      await expect(asUser(users.admin, (q) => q(`SELECT * FROM migrations`))).rejects.toThrow(/permission denied/);
    });

    it('the connection\'s own role is not restricted (workers, seeds and migrations keep working)', async () => {
      await world();
      const [{ count }] = await ds.query(`SELECT count(*)::int AS count FROM cases`);
      expect(count).toBe(5);
    });
  });
});
