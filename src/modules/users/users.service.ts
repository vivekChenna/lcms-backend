import type { DataSource, EntityManager } from 'typeorm';
import { User } from './entities/user.entity';
import { Role, RoleName } from './entities/role.entity';
import { UserRole } from './entities/user-role.entity';
import { sendPasswordLink, sendPasswordLinkAsAdmin, type PasswordLinkDeps } from '../auth/password-links';
import { logAuditEvent } from '../audit/audit.service';
import { Department } from '../master-data/entities/department.entity';
import { OrgEntity } from '../master-data/entities/org-entity.entity';
import { BusinessUnit } from '../master-data/entities/business-unit.entity';
import { deactivateRoutingRulesForIneligibleTarget } from '../master-data/routing-rules.service';
import { ConflictError, NotFoundError, ValidationError, ForbiddenError } from '../../shared/errors';
import { PaginationQuery, paginationToSkipTake } from '../../shared/pagination';

export type UserWithRole = {
  id: string;
  fullName: string;
  email: string;
  designation: string | null;
  phone: string | null;
  departmentId: string | null;
  entityId: string | null;
  businessUnitId: string | null;
  isActive: boolean;
  isInvited: boolean;
  role: RoleName;
  createdAt: string;
  updatedAt: string;
};

function toUserWithRole(user: User, role: RoleName): UserWithRole {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    designation: user.designation,
    phone: user.phone,
    departmentId: user.departmentId,
    entityId: user.entityId,
    businessUnitId: user.businessUnitId,
    isActive: user.isActive,
    isInvited: user.passwordHash === null,
    role,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export async function assignRole(
  dataSource: DataSource | EntityManager,
  userId: string,
  roleId: string,
  assignedBy: string,
): Promise<void> {
  await dataSource
    .getRepository(UserRole)
    .upsert({ userId, roleId, assignedBy }, { conflictPaths: ['userId'] });
}

export type CreateUserInput = {
  fullName: string;
  email: string;
  designation?: string;
  phone?: string;
  departmentId?: string;
  entityId?: string;
  businessUnitId?: string;
};

async function assertValidOrgReferences(
  dataSource: DataSource,
  input: { departmentId?: string | null; entityId?: string | null; businessUnitId?: string | null },
): Promise<void> {
  if (input.departmentId) {
    const department = await dataSource.getRepository(Department).findOne({ where: { id: input.departmentId } });
    if (!department) {
      throw new ValidationError('Unknown departmentId');
    }
  }
  if (input.entityId) {
    const entity = await dataSource.getRepository(OrgEntity).findOne({ where: { id: input.entityId } });
    if (!entity) {
      throw new ValidationError('Unknown entityId');
    }
  }
  if (input.businessUnitId) {
    const businessUnit = await dataSource.getRepository(BusinessUnit).findOne({ where: { id: input.businessUnitId } });
    if (!businessUnit) {
      throw new ValidationError('Unknown businessUnitId');
    }
  }
}

export async function createUser(
  deps: PasswordLinkDeps,
  actorId: string,
  input: CreateUserInput,
): Promise<UserWithRole & { inviteEmailSent: boolean }> {
  const { dataSource } = deps;
  const email = input.email.toLowerCase();
  const userRepo = dataSource.getRepository(User);

  const existing = await userRepo.findOne({ where: { email } });
  if (existing) {
    throw new ConflictError('A user with this email already exists');
  }

  await assertValidOrgReferences(dataSource, input);

  // The user row and its role row are two writes that both have to land for
  // the user to be usable at all: loadAuthenticatedUser (every login, every
  // authenticated request) does a findOneOrFail on user_roles, so a user
  // that exists without a role row is permanently broken — login 500s,
  // GET /users/:id 500s, and GET /users 500s for the whole page containing
  // them (the role-name column fails its response-schema enum). A crash
  // between these two writes previously left exactly that half-created row
  // with no way to recover via the API. Wrapped in a transaction so either
  // both land or neither does (code review finding — scoped to this pair;
  // the broader mutation+audit transaction question elsewhere is deferred).
  const user = await dataSource.transaction(async (manager) => {
    const created = await manager.getRepository(User).save(
      manager.getRepository(User).create({
        fullName: input.fullName,
        email,
        // no password: the person chooses their own from the emailed link
        passwordHash: null,
        designation: input.designation ?? null,
        phone: input.phone ?? null,
        departmentId: input.departmentId ?? null,
        entityId: input.entityId ?? null,
        businessUnitId: input.businessUnitId ?? null,
        isActive: true,
      }),
    );

    const requesterRole = await manager.getRepository(Role).findOneOrFail({ where: { name: 'requester' as RoleName } });
    await assignRole(manager, created.id, requesterRole.id, actorId);

    return created;
  });

  await logAuditEvent(dataSource, {
    actorId,
    action: 'user.created',
    afterValue: { id: user.id, email: user.email, role: 'requester' },
  });

  const inviteEmailSent = await sendPasswordLink(deps, user, 'invite', { actorId, action: 'user.password_link_sent' });

  return { ...toUserWithRole(user, 'requester'), inviteEmailSent };
}

export type ListUsersQuery = PaginationQuery & { role?: RoleName; isActive?: boolean; search?: string };

export async function listUsers(
  dataSource: DataSource,
  query: ListUsersQuery,
): Promise<{ items: UserWithRole[]; total: number }> {
  const { skip, take } = paginationToSkipTake(query);

  const qb = dataSource
    .getRepository(User)
    .createQueryBuilder('user')
    .leftJoin(UserRole, 'ur', 'ur."userId" = user.id')
    .leftJoin(Role, 'role', 'role.id = ur."roleId"');
  if (query.role) qb.andWhere('role.name = :role', { role: query.role });
  if (query.isActive !== undefined) qb.andWhere('user.isActive = :isActive', { isActive: query.isActive });
  if (query.search) {
    qb.andWhere('(user.fullName ILIKE :search OR user.email ILIKE :search)', {
      search: `%${query.search.replace(/[\\%_]/g, '\\$&')}%`,
    });
  }

  const total = await qb.getCount();
  const { entities, raw } = await qb
    .addSelect('role.name', 'role_name')
    .orderBy('user.createdAt', 'DESC')
    .addOrderBy('user.id', 'DESC')
    .skip(skip)
    .take(take)
    .getRawAndEntities();

  const items = entities.map((user, idx) => toUserWithRole(user, raw[idx].role_name as RoleName));
  return { items, total };
}

export async function getUserById(dataSource: DataSource, id: string): Promise<UserWithRole> {
  const user = await dataSource.getRepository(User).findOne({ where: { id } });
  if (!user) {
    throw new NotFoundError('User not found');
  }
  const userRole = await dataSource.getRepository(UserRole).findOneOrFail({ where: { userId: id } });
  const role = await dataSource.getRepository(Role).findOneOrFail({ where: { id: userRole.roleId } });
  return toUserWithRole(user, role.name);
}

export async function updateUserRole(
  dataSource: DataSource,
  actorId: string,
  userId: string,
  roleName: RoleName,
): Promise<UserWithRole> {
  if (actorId === userId) {
    throw new ForbiddenError('You cannot change your own role — this prevents a lockout with zero admins');
  }

  const user = await dataSource.getRepository(User).findOne({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError('User not found');
  }

  const role = await dataSource.getRepository(Role).findOne({ where: { name: roleName } });
  if (!role) {
    throw new ValidationError(`Unknown role: ${roleName}`);
  }

  const previous = await dataSource.getRepository(UserRole).findOne({ where: { userId } });
  await assignRole(dataSource, userId, role.id, actorId);

  await logAuditEvent(dataSource, {
    actorId,
    action: 'user.role_changed',
    beforeValue: { userId, email: user.email, roleId: previous?.roleId ?? null },
    afterValue: { userId, email: user.email, roleId: role.id, roleName: role.name },
  });

  if (roleName !== 'legal_rep' && roleName !== 'legal_manager') {
    await deactivateRoutingRulesForIneligibleTarget(dataSource, actorId, userId);
  }

  return toUserWithRole(user, role.name);
}

export async function deactivateUser(dataSource: DataSource, actorId: string, userId: string): Promise<UserWithRole> {
  if (actorId === userId) {
    throw new ForbiddenError('You cannot deactivate your own account');
  }

  const userRepo = dataSource.getRepository(User);
  const user = await userRepo.findOne({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError('User not found');
  }

  user.isActive = false;
  await userRepo.save(user);

  const userRole = await dataSource.getRepository(UserRole).findOneOrFail({ where: { userId } });
  const role = await dataSource.getRepository(Role).findOneOrFail({ where: { id: userRole.roleId } });

  await logAuditEvent(dataSource, {
    actorId,
    action: 'user.deactivated',
    beforeValue: { userId, email: user.email, isActive: true },
    afterValue: { userId, email: user.email, isActive: false },
  });

  await deactivateRoutingRulesForIneligibleTarget(dataSource, actorId, userId);

  return toUserWithRole(user, role.name);
}

export async function activateUser(dataSource: DataSource, actorId: string, userId: string): Promise<UserWithRole> {
  const userRepo = dataSource.getRepository(User);
  const user = await userRepo.findOne({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError('User not found');
  }

  const userRole = await dataSource.getRepository(UserRole).findOneOrFail({ where: { userId } });
  const role = await dataSource.getRepository(Role).findOneOrFail({ where: { id: userRole.roleId } });

  if (user.isActive) {
    return toUserWithRole(user, role.name);
  }

  user.isActive = true;
  await userRepo.save(user);

  await logAuditEvent(dataSource, {
    actorId,
    action: 'user.activated',
    beforeValue: { userId, email: user.email, isActive: false },
    afterValue: { userId, email: user.email, isActive: true },
  });

  return toUserWithRole(user, role.name);
}

export type UpdateUserInput = {
  fullName?: string;
  designation?: string | null;
  phone?: string | null;
  departmentId?: string | null;
  entityId?: string | null;
  businessUnitId?: string | null;
};

export async function updateUser(
  dataSource: DataSource,
  actorId: string,
  userId: string,
  input: UpdateUserInput,
): Promise<UserWithRole> {
  const userRepo = dataSource.getRepository(User);
  const user = await userRepo.findOne({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError('User not found');
  }

  await assertValidOrgReferences(dataSource, input);

  const before = {
    userId,
    fullName: user.fullName,
    designation: user.designation,
    phone: user.phone,
    departmentId: user.departmentId,
    entityId: user.entityId,
    businessUnitId: user.businessUnitId,
  };

  if (input.fullName !== undefined) user.fullName = input.fullName;
  if (input.designation !== undefined) user.designation = input.designation;
  if (input.phone !== undefined) user.phone = input.phone;
  if (input.departmentId !== undefined) user.departmentId = input.departmentId;
  if (input.entityId !== undefined) user.entityId = input.entityId;
  if (input.businessUnitId !== undefined) user.businessUnitId = input.businessUnitId;

  await userRepo.save(user);

  const userRole = await dataSource.getRepository(UserRole).findOneOrFail({ where: { userId } });
  const role = await dataSource.getRepository(Role).findOneOrFail({ where: { id: userRole.roleId } });

  await logAuditEvent(dataSource, {
    actorId,
    action: 'user.updated',
    beforeValue: before,
    afterValue: {
      userId,
      fullName: user.fullName,
      designation: user.designation,
      phone: user.phone,
      departmentId: user.departmentId,
      entityId: user.entityId,
      businessUnitId: user.businessUnitId,
    },
  });

  return toUserWithRole(user, role.name);
}

/** Admin: email an active user a link to choose a new password (admins never set one). */
export async function sendUserPasswordLink(deps: PasswordLinkDeps, actorId: string, userId: string): Promise<void> {
  const user = await deps.dataSource.getRepository(User).findOne({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError('User not found');
  }
  if (!user.isActive) {
    throw new ConflictError('This user is deactivated. Activate them before sending a password link.');
  }
  await sendPasswordLinkAsAdmin(deps, actorId, user);
}
