import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Row-level security (BRD AC-03): the access rules are enforced by Postgres itself, not only by the
 * API, so a query that forgets a check still cannot return a row its user may not see.
 *
 * How it works:
 *  - A NOLOGIN role, lcms_app, holds the restricted privileges. The application connects as its
 *    usual database user and runs each request's queries under `SET ROLE lcms_app` with
 *    `app.user_id` set to the authenticated user (see src/db/row-level-security.ts).
 *  - The policies decide from the database's own data: the user's role and department are looked up
 *    from users / user_roles, never taken from a value the application sends. Only the user id is
 *    supplied, and only by the code that has just verified the access token.
 *  - The owner role (migrations, seeds, background workers) is not restricted: tables are not FORCEd.
 *
 * The rules mirror canActorSeeCase / applyCaseFilters in the cases service:
 *  - legal representative, legal manager, admin: every case
 *  - viewer: non-confidential cases, read only
 *  - requester: their own cases, other non-confidential cases of their department, and any case
 *    they have been asked an information request on
 * Documents, comments, information requests and audit rows follow the case they belong to. Internal
 * comments are legal-only. The audit log is append-only (no UPDATE or DELETE for the role at all).
 */
export class RowLevelSecurity1700000016000 implements MigrationInterface {
  name = 'RowLevelSecurity1700000016000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Whichever schema this connection actually resolves unqualified names against --
    // 'public' by default, or DB_SCHEMA (see src/db/data-source.ts) in a shared database
    // where this app has its own schema. Everything below that would otherwise hardcode
    // 'public' uses this instead, so the same migration works in both deployments.
    const [{ schema }] = (await queryRunner.query(`SELECT current_schema() AS schema`)) as [{ schema: string }];

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lcms_app') THEN
          CREATE ROLE lcms_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        END IF;
      END
      $$
    `);
    // the connecting user must be able to SET ROLE lcms_app
    await queryRunner.query(`GRANT lcms_app TO CURRENT_USER`);

    await queryRunner.query(`GRANT USAGE ON SCHEMA "${schema}" TO lcms_app`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO lcms_app`);
    await queryRunner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO lcms_app`);
    await queryRunner.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lcms_app`,
    );
    await queryRunner.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT USAGE, SELECT ON SEQUENCES TO lcms_app`,
    );
    // the audit trail is append-only, and the migration bookkeeping is not the application's business
    await queryRunner.query(`REVOKE UPDATE, DELETE ON audit_log FROM lcms_app`);
    await queryRunner.query(`REVOKE ALL ON migrations FROM lcms_app`);

    // ---- who is asking ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE FUNCTION app_current_user_id() RETURNS uuid
      LANGUAGE sql STABLE
      AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$
    `);
    // role and department come from the tables, so they cannot be forged by what the app sends
    await queryRunner.query(`
      CREATE FUNCTION app_current_role() RETURNS text
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "${schema}", pg_temp
      AS $$
        SELECT r.name
        FROM user_roles ur
        JOIN roles r ON r.id = ur."roleId"
        JOIN users u ON u.id = ur."userId"
        WHERE ur."userId" = app_current_user_id() AND u."isActive" = true
        LIMIT 1
      $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION app_current_department_id() RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "${schema}", pg_temp
      AS $$ SELECT "departmentId" FROM users WHERE id = app_current_user_id() $$
    `);
    // answers "is this user the responder of an information request on the case" without being
    // subject to the information_requests policies themselves (which would recurse)
    await queryRunner.query(`
      CREATE FUNCTION app_answers_for_case(p_case uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "${schema}", pg_temp
      AS $$
        SELECT EXISTS (
          SELECT 1 FROM information_requests ir
          WHERE ir."caseId" = p_case AND ir."responderId" = app_current_user_id()
        )
      $$
    `);

    // ---- the case visibility rule ------------------------------------------------------------
    await queryRunner.query(`
      CREATE FUNCTION app_case_visible(p_requester uuid, p_department uuid, p_confidential boolean, p_case uuid)
      RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "${schema}", pg_temp
      AS $$
        SELECT CASE app_current_role()
          WHEN 'legal_rep' THEN true
          WHEN 'legal_manager' THEN true
          WHEN 'admin' THEN true
          WHEN 'viewer' THEN NOT p_confidential
          WHEN 'requester' THEN (
            p_requester = app_current_user_id()
            OR (p_department = app_current_department_id() AND NOT p_confidential)
            OR app_answers_for_case(p_case)
          )
          ELSE false
        END
      $$
    `);
    // the same rule, for a row that belongs to a case (documents, comments, information requests, audit)
    await queryRunner.query(`
      CREATE FUNCTION app_can_see_case(p_case uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "${schema}", pg_temp
      AS $$
        SELECT COALESCE(
          (SELECT app_case_visible(c."requesterId", c."departmentId", c."isConfidential", c.id)
           FROM cases c WHERE c.id = p_case),
          false)
      $$
    `);
    // may this user change data at all (viewers, and anyone unknown, may not)
    await queryRunner.query(`
      CREATE FUNCTION app_can_write() RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "${schema}", pg_temp
      AS $$ SELECT COALESCE(app_current_role() IN ('requester', 'legal_rep', 'legal_manager', 'admin'), false) $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION app_is_legal() RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "${schema}", pg_temp
      AS $$ SELECT COALESCE(app_current_role() IN ('legal_rep', 'legal_manager', 'admin'), false) $$
    `);

    for (const fn of [
      'app_current_user_id()',
      'app_current_role()',
      'app_current_department_id()',
      'app_answers_for_case(uuid)',
      'app_case_visible(uuid, uuid, boolean, uuid)',
      'app_can_see_case(uuid)',
      'app_can_write()',
      'app_is_legal()',
    ]) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
      await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${fn} TO lcms_app`);
    }

    // ---- cases -------------------------------------------------------------------------------
    await queryRunner.query(`ALTER TABLE cases ENABLE ROW LEVEL SECURITY`);
    const visible = `app_case_visible("requesterId", "departmentId", "isConfidential", id)`;
    await queryRunner.query(`CREATE POLICY cases_select ON cases FOR SELECT TO lcms_app USING (${visible})`);
    await queryRunner.query(
      `CREATE POLICY cases_insert ON cases FOR INSERT TO lcms_app WITH CHECK (app_can_write() AND ${visible})`,
    );
    await queryRunner.query(
      `CREATE POLICY cases_update ON cases FOR UPDATE TO lcms_app
         USING (${visible}) WITH CHECK (app_can_write() AND ${visible})`,
    );

    // ---- rows that belong to a case ----------------------------------------------------------
    for (const table of ['documents', 'information_requests']) {
      await queryRunner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(
        `CREATE POLICY ${table}_select ON ${table} FOR SELECT TO lcms_app USING (app_can_see_case("caseId"))`,
      );
      // the person an information request is addressed to may answer it whatever their role (AC-15)
      await queryRunner.query(
        `CREATE POLICY ${table}_insert ON ${table} FOR INSERT TO lcms_app
           WITH CHECK ((app_can_write() OR app_answers_for_case("caseId")) AND app_can_see_case("caseId"))`,
      );
      await queryRunner.query(
        `CREATE POLICY ${table}_update ON ${table} FOR UPDATE TO lcms_app
           USING (app_can_see_case("caseId"))
           WITH CHECK ((app_can_write() OR app_answers_for_case("caseId")) AND app_can_see_case("caseId"))`,
      );
    }

    // comments: internal notes are for legal staff only (AC-10)
    await queryRunner.query(`ALTER TABLE comments ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(
      `CREATE POLICY comments_select ON comments FOR SELECT TO lcms_app
         USING (app_can_see_case("caseId") AND (NOT "isInternal" OR app_is_legal()))`,
    );
    await queryRunner.query(
      `CREATE POLICY comments_insert ON comments FOR INSERT TO lcms_app
         WITH CHECK (app_can_write() AND app_can_see_case("caseId") AND (NOT "isInternal" OR app_is_legal()))`,
    );
    await queryRunner.query(
      `CREATE POLICY comments_update ON comments FOR UPDATE TO lcms_app
         USING (app_can_see_case("caseId") AND (NOT "isInternal" OR app_is_legal()))
         WITH CHECK (app_can_write() AND app_can_see_case("caseId") AND (NOT "isInternal" OR app_is_legal()))`,
    );

    // audit log: readable with its case; the user's own entries; account-level entries for managers and
    // admins. Anyone may append (the API decides what is audited); nobody changes or removes a row.
    await queryRunner.query(`ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(
      `CREATE POLICY audit_log_select ON audit_log FOR SELECT TO lcms_app
         USING (
           "actorId" = app_current_user_id()
           OR ("caseId" IS NULL AND app_current_role() IN ('legal_manager', 'admin'))
           OR ("caseId" IS NOT NULL AND app_can_see_case("caseId"))
         )`,
    );
    await queryRunner.query(`CREATE POLICY audit_log_insert ON audit_log FOR INSERT TO lcms_app WITH CHECK (true)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, policies] of Object.entries({
      cases: ['cases_select', 'cases_insert', 'cases_update'],
      documents: ['documents_select', 'documents_insert', 'documents_update'],
      information_requests: ['information_requests_select', 'information_requests_insert', 'information_requests_update'],
      comments: ['comments_select', 'comments_insert', 'comments_update'],
      audit_log: ['audit_log_select', 'audit_log_insert'],
    })) {
      for (const policy of policies) {
        await queryRunner.query(`DROP POLICY IF EXISTS ${policy} ON ${table}`);
      }
      await queryRunner.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
    }
    for (const fn of [
      'app_is_legal()',
      'app_can_write()',
      'app_can_see_case(uuid)',
      'app_case_visible(uuid, uuid, boolean, uuid)',
      'app_answers_for_case(uuid)',
      'app_current_department_id()',
      'app_current_role()',
      'app_current_user_id()',
    ]) {
      await queryRunner.query(`DROP FUNCTION IF EXISTS ${fn}`);
    }
    // The role itself is a cluster-wide object that other databases here may still use: keep it, but
    // take back everything it was given in this database.
    await queryRunner.query(`DROP OWNED BY lcms_app`);
    await queryRunner.query(`REVOKE lcms_app FROM CURRENT_USER`);
  }
}
