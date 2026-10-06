import 'reflect-metadata';
import type { DataSource } from 'typeorm';
import { hashPassword } from '../shared/password';
import { User } from '../modules/users/entities/user.entity';
import { Role } from '../modules/users/entities/role.entity';
import { UserRole } from '../modules/users/entities/user-role.entity';
import { CaseCategory } from '../modules/master-data/entities/case-category.entity';
import { CaseType } from '../modules/master-data/entities/case-type.entity';
import { Department } from '../modules/master-data/entities/department.entity';
import { OrgEntity } from '../modules/master-data/entities/org-entity.entity';
import { BusinessUnit } from '../modules/master-data/entities/business-unit.entity';
import { ClosureOutcome } from '../modules/master-data/entities/closure-outcome.entity';
import { Case } from '../modules/cases/entities/case.entity';
import { submitCase, type Actor, type CreateCaseInput } from '../modules/cases/cases.service';
import { assignCase, acceptAssignment, closeCase, setEscalation } from '../modules/cases/cases.workflow.service';
import { raiseInformationRequest } from '../modules/information-requests/information-requests.service';
import { createComment } from '../modules/comments/comments.service';

const PASSWORD = 'Password123!';

const DEMO_USERS = {
  admin: { email: 'vivekadmin@gmail.com', fullName: 'Vivek Admin', role: 'admin' },
  manager: { email: 'viveklegalmanager@gmail.com', fullName: 'Vivek Legal Manager', role: 'legal_manager' },
  rep1: { email: 'viveklegalrep@gmail.com', fullName: 'Vivek Legal Rep', role: 'legal_rep' },
  rep2: { email: 'viveklegalrep2@gmail.com', fullName: 'Vivek Legal Rep Two', role: 'legal_rep' },
  requester: { email: 'vivek@gmail.com', fullName: 'Vivek Requester', role: 'requester' },
  viewer: { email: 'vivekviewer@gmail.com', fullName: 'Vivek Viewer', role: 'viewer' },
} as const;

type DemoKey = keyof typeof DEMO_USERS;
type DemoUsers = Record<DemoKey, { id: string; email: string }>;

async function findOrCreate<T extends object>(dataSource: DataSource, entity: new () => T, where: object, values: object): Promise<T> {
  const repo = dataSource.getRepository(entity);
  const existing = await repo.findOne({ where: where as never });
  if (existing) return existing;
  return repo.save(repo.create({ ...where, ...values } as never) as never) as Promise<T>;
}

async function seedMasterData(dataSource: DataSource) {
  const internal = await findOrCreate(dataSource, CaseCategory, { name: 'Internal' }, {});
  const commercial = await findOrCreate(dataSource, CaseCategory, { name: 'Commercial' }, {});
  const internalType = await findOrCreate(dataSource, CaseType, { categoryId: internal.id, name: 'Internal Legal Query' }, { slaAckHours: 24, slaResolutionHours: 72 });
  const commercialType = await findOrCreate(dataSource, CaseType, { categoryId: commercial.id, name: 'Commercial Contract Review' }, { slaAckHours: 24, slaResolutionHours: 120 });
  const finance = await findOrCreate(dataSource, Department, { name: 'Finance' }, {});
  await findOrCreate(dataSource, Department, { name: 'Operations' }, {});
  const entity = await findOrCreate(dataSource, OrgEntity, { name: 'AGC' }, { code: 'AGC' });
  const businessUnit = await findOrCreate(dataSource, BusinessUnit, { entityId: entity.id, name: 'Head Office' }, {});
  const resolved = await findOrCreate(dataSource, ClosureOutcome, { name: 'Resolved' }, {});
  await findOrCreate(dataSource, ClosureOutcome, { name: 'Withdrawn' }, {});
  return { internal, commercial, internalType, commercialType, finance, entity, businessUnit, resolved };
}

async function seedUsers(
  dataSource: DataSource,
  master: Awaited<ReturnType<typeof seedMasterData>>,
): Promise<{ users: DemoUsers; actors: Record<DemoKey, Actor> }> {
  const userRepo = dataSource.getRepository(User);
  const users = {} as DemoUsers;
  const actors = {} as Record<DemoKey, Actor>;
  let passwordHash: string | undefined;

  for (const key of Object.keys(DEMO_USERS) as DemoKey[]) {
    const def = DEMO_USERS[key];
    const org = key === 'requester'
      ? { departmentId: master.finance.id, entityId: master.entity.id, businessUnitId: master.businessUnit.id }
      : { departmentId: null, entityId: null, businessUnitId: null };
    let user = await userRepo.findOne({ where: { email: def.email } });
    if (!user) {
      passwordHash ??= await hashPassword(PASSWORD);
      user = await userRepo.save(userRepo.create({ fullName: def.fullName, email: def.email, passwordHash, isActive: true, ...org }));
      const role = await dataSource.getRepository(Role).findOneOrFail({ where: { name: def.role } });
      await dataSource.getRepository(UserRole).save({ userId: user.id, roleId: role.id });
    }
    users[key] = { id: user.id, email: user.email };
    actors[key] = { id: user.id, role: def.role, ...org };
  }
  return { users, actors };
}

export async function seedDemo(dataSource: DataSource): Promise<{ users: DemoUsers; caseIds: string[] }> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed:demo must not run in production');
  }

  const master = await seedMasterData(dataSource);
  const { users, actors } = await seedUsers(dataSource, master);
  const caseRepo = dataSource.getRepository(Case);

  const baseInput = (title: string, extra: Partial<CreateCaseInput> = {}): CreateCaseInput => ({
    title,
    description: `${title}. Demo data created by seed:demo to exercise the case workflow.`,
    declarationConfirmed: true,
    categoryId: master.internal.id,
    caseTypeId: master.internalType.id,
    departmentId: master.finance.id,
    priority: 'P3',
    ...extra,
  });

  // Each scenario creates one case (found again by its fixed title on re-runs)
  // and moves it into its target state through the real services.
  const scenarios: { title: string; extra?: Partial<CreateCaseInput>; advance?: (caseId: string) => Promise<void> }[] = [
    { title: '[Demo] Vendor payment dispute (Submitted)', extra: { priority: 'P2' } },
    {
      title: '[Demo] Lease renewal advice (Assigned)',
      advance: async (id) => {
        await assignCase(dataSource, users.manager.id, id, users.rep1.id);
      },
    },
    {
      title: '[Demo] Employee contract query (In Progress)',
      extra: { priority: 'P2' },
      advance: async (id) => {
        await assignCase(dataSource, users.manager.id, id, users.rep1.id);
        await acceptAssignment(dataSource, users.rep1.id, id);
        await createComment(dataSource, actors.rep1, id, { body: 'Internal note: checking the precedent file before replying.', isInternal: true });
        await createComment(dataSource, actors.rep1, id, { body: 'We are reviewing your query and will update you shortly.', isInternal: false });
      },
    },
    {
      title: '[Demo] Licence document request (Waiting on Input)',
      advance: async (id) => {
        await assignCase(dataSource, users.manager.id, id, users.rep1.id);
        await acceptAssignment(dataSource, users.rep1.id, id);
        await raiseInformationRequest(dataSource, users.rep1.id, id, {
          subject: 'Signed licence copy needed',
          requirementDescription: 'Please upload the signed copy of the licence agreement.',
          responderId: users.requester.id,
        });
      },
    },
    {
      title: '[Demo] Regulatory notice response (Escalated)',
      extra: { priority: 'P1' },
      advance: async (id) => {
        await assignCase(dataSource, users.manager.id, id, users.rep1.id);
        await acceptAssignment(dataSource, users.rep1.id, id);
        await setEscalation(dataSource, actors.rep1, id, true, 'Regulator deadline is close; needs manager attention.');
      },
    },
    {
      title: '[Demo] Supplier agreement review (Closed)',
      advance: async (id) => {
        await assignCase(dataSource, users.manager.id, id, users.rep1.id);
        await acceptAssignment(dataSource, users.rep1.id, id);
        await closeCase(dataSource, actors.rep1, id, { closureSummary: 'Agreement reviewed and approved with minor edits.', closureOutcomeId: master.resolved.id });
      },
    },
    { title: '[Demo] Confidential HR matter (Submitted)', extra: { isConfidential: true, priority: 'P1' } },
    {
      title: '[Demo] Overdue contract dispute (SLA breached)',
      extra: { priority: 'P2' },
      advance: async (id) => {
        await assignCase(dataSource, users.manager.id, id, users.rep2.id);
        await caseRepo.update(id, { resolutionDueAt: new Date(Date.now() - 24 * 60 * 60 * 1000) });
      },
    },
  ];

  const caseIds: string[] = [];
  for (const scenario of scenarios) {
    const existing = await caseRepo.findOne({ where: { title: scenario.title, requesterId: users.requester.id } });
    if (existing) {
      caseIds.push(existing.id);
      continue;
    }
    const created = await submitCase(dataSource, actors.requester, baseInput(scenario.title, scenario.extra));
    await scenario.advance?.(created.id);
    caseIds.push(created.id);
  }

  return { users, caseIds };
}

async function main(): Promise<void> {
  const { AppDataSource } = await import('./data-source.js');
  await AppDataSource.initialize();
  try {
    const { users, caseIds } = await seedDemo(AppDataSource);
    console.log('Demo data ready. Log in with password "Password123!":');
    console.table(Object.entries(users).map(([key, u]) => ({ account: key, email: u.email })));
    console.log(`${caseIds.length} demo cases present.`);
  } finally {
    await AppDataSource.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
