import type { DataSource } from 'typeorm';
import { User } from './entities/user.entity';
import { Role, RoleName } from './entities/role.entity';
import { UserRole } from './entities/user-role.entity';
import { hashPassword } from '../../shared/password';
import { logAuditEvent } from '../audit/audit.service';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
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
  role: string;
  createdAt: string;
  updatedAt: string;
};

function toUserWithRole(user: User, role: string): UserWithRole {
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
    role,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export async function assignRole(
  dataSource: DataSource,
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
  password: string;
  designation?: string;
  phone?: string;
  departmentId?: string;
  entityId?: string;
  businessUnitId?: string;
};

export async function createUser(
  dataSource: DataSource,
  actorId: string,
  input: CreateUserInput,
): Promise<UserWithRole> {
  const email = input.email.toLowerCase();
  const userRepo = dataSource.getRepository(User);

  const existing = await userRepo.findOne({ where: { email } });
  if (existing) {
    throw new ConflictError('A user with this email already exists');
  }

  const passwordHash = await hashPassword(input.password);
  const user = await userRepo.save(
    userRepo.create({
      fullName: input.fullName,
      email,
      passwordHash,
      designation: input.designation ?? null,
      phone: input.phone ?? null,
      departmentId: input.departmentId ?? null,
      entityId: input.entityId ?? null,
      businessUnitId: input.businessUnitId ?? null,
      isActive: true,
    }),
  );

  const requesterRole = await dataSource.getRepository(Role).findOneOrFail({ where: { name: 'requester' as RoleName } });
  await assignRole(dataSource, user.id, requesterRole.id, actorId);

  await logAuditEvent(dataSource, {
    actorId,
    action: 'user.created',
    afterValue: { id: user.id, email: user.email, role: 'requester' },
  });

  return toUserWithRole(user, 'requester');
}
