import crypto from 'node:crypto';
import { IsNull, type DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Role } from '../users/entities/role.entity';
import { UserRole } from '../users/entities/user-role.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { Department } from '../master-data/entities/department.entity';
import { OrgEntity } from '../master-data/entities/org-entity.entity';
import { BusinessUnit } from '../master-data/entities/business-unit.entity';
import { verifyPassword, hashPassword } from '../../shared/password';
import { UnauthorizedError, ValidationError } from '../../shared/errors';
import type { AuthenticatedUser } from '../../shared/rbac';

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateOpaqueToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export async function loadAuthenticatedUser(dataSource: DataSource, user: User): Promise<AuthenticatedUser> {
  const userRole = await dataSource.getRepository(UserRole).findOneOrFail({ where: { userId: user.id } });
  const role = await dataSource.getRepository(Role).findOneOrFail({ where: { id: userRole.roleId } });
  return {
    id: user.id,
    role: role.name,
    departmentId: user.departmentId,
    entityId: user.entityId,
    businessUnitId: user.businessUnitId,
  };
}

export type Profile = {
  id: string; fullName: string; email: string; designation: string | null; role: string;
  departmentId: string | null; departmentName: string | null;
  entityId: string | null; entityName: string | null;
  businessUnitId: string | null; businessUnitName: string | null;
};

export async function loadProfile(dataSource: DataSource, userId: string): Promise<Profile> {
  const user = await dataSource.getRepository(User).findOneOrFail({ where: { id: userId } });
  const { role } = await loadAuthenticatedUser(dataSource, user);
  const [department, entity, businessUnit] = await Promise.all([
    user.departmentId ? dataSource.getRepository(Department).findOne({ where: { id: user.departmentId } }) : null,
    user.entityId ? dataSource.getRepository(OrgEntity).findOne({ where: { id: user.entityId } }) : null,
    user.businessUnitId ? dataSource.getRepository(BusinessUnit).findOne({ where: { id: user.businessUnitId } }) : null,
  ]);
  return {
    id: user.id, fullName: user.fullName, email: user.email, designation: user.designation, role,
    departmentId: user.departmentId, departmentName: department?.name ?? null,
    entityId: user.entityId, entityName: entity?.name ?? null,
    businessUnitId: user.businessUnitId, businessUnitName: businessUnit?.name ?? null,
  };
}

export async function issueRefreshToken(
  dataSource: DataSource,
  userId: string,
  expiresInDays: number,
): Promise<string> {
  const repo = dataSource.getRepository(RefreshToken);
  const token = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  await repo.save(repo.create({ userId, tokenHash: hashToken(token), expiresAt }));
  return token;
}

export async function login(
  dataSource: DataSource,
  refreshTokenExpiresDays: number,
  email: string,
  password: string,
): Promise<{ user: AuthenticatedUser; refreshToken: string }> {
  const user = await dataSource.getRepository(User).findOne({ where: { email: email.toLowerCase() } });
  // an invited user has no password yet (passwordHash is null), so there is nothing to match
  if (!user || !user.isActive || !user.passwordHash) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const passwordOk = await verifyPassword(user.passwordHash, password);
  if (!passwordOk) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const authenticatedUser = await loadAuthenticatedUser(dataSource, user);
  const refreshToken = await issueRefreshToken(dataSource, user.id, refreshTokenExpiresDays);
  return { user: authenticatedUser, refreshToken };
}

/**
 * Drona sign-in: the DronaHQ container reports the profile email and the user's existing, active account is
 * signed in. Nothing is created, and the email is not proof of who is asking (see docs/drona-sign-in.md).
 */
export async function loginWithDronaEmail(
  dataSource: DataSource,
  refreshTokenExpiresDays: number,
  email: string,
): Promise<{ user: AuthenticatedUser; refreshToken: string }> {
  const user = await dataSource.getRepository(User).findOne({ where: { email: email.toLowerCase() } });
  if (!user || !user.isActive) {
    throw new UnauthorizedError('No active LCMS account matches this Drona profile. Contact your administrator.');
  }
  const authenticatedUser = await loadAuthenticatedUser(dataSource, user);
  const refreshToken = await issueRefreshToken(dataSource, user.id, refreshTokenExpiresDays);
  return { user: authenticatedUser, refreshToken };
}

export async function logout(dataSource: DataSource, presentedToken: string): Promise<void> {
  await dataSource.getRepository(RefreshToken).update({ tokenHash: hashToken(presentedToken) }, { revokedAt: new Date() });
}

// Used after a password change (self-service or admin reset) — the new
// password is only useful if every session minted under the old one is
// also cut off, otherwise a credential that was just changed (because it
// may have leaked) still has live sessions riding on it.
export async function revokeAllRefreshTokens(dataSource: DataSource, userId: string): Promise<void> {
  await dataSource.getRepository(RefreshToken).update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
}

export async function changePassword(
  dataSource: DataSource,
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await dataSource.getRepository(User).findOneOrFail({ where: { id: userId } });
  const currentOk = user.passwordHash !== null && (await verifyPassword(user.passwordHash, currentPassword));
  if (!currentOk) {
    throw new ValidationError('Current password is incorrect');
  }
  const passwordHash = await hashPassword(newPassword);
  await dataSource.getRepository(User).update({ id: userId }, { passwordHash });
  await revokeAllRefreshTokens(dataSource, userId);
}

export async function refreshSession(
  dataSource: DataSource,
  refreshTokenExpiresDays: number,
  presentedToken: string,
): Promise<{ user: AuthenticatedUser; refreshToken: string }> {
  // Atomic claim: a plain find-then-update is a read-then-write race — two
  // concurrent requests presenting the same token can both read it as
  // unrevoked before either write lands, both mint a session, and the
  // "replay of a used token" guarantee is lost. The UPDATE...WHERE...RETURNING
  // makes the claim itself the race's only decision point: Postgres locks
  // the row per-statement, so only the request whose UPDATE actually matches
  // an unrevoked row gets a result back (code review finding — verified with
  // 5-way concurrent replay, 20 rounds).
  // TypeORM's raw query() for an UPDATE...RETURNING returns a [rows, affectedCount]
  // tuple for Postgres, not the rows array directly — destructure it.
  const [claimedRows] = await dataSource.query(
    `UPDATE refresh_tokens SET "revokedAt" = now()
     WHERE "tokenHash" = $1 AND "revokedAt" IS NULL AND "expiresAt" > now()
     RETURNING "userId"`,
    [hashToken(presentedToken)],
  ) as [Array<{ userId: string }>, number];

  if (claimedRows.length !== 1) {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  const user = await dataSource.getRepository(User).findOne({ where: { id: claimedRows[0].userId } });
  if (!user || !user.isActive) {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  const authenticatedUser = await loadAuthenticatedUser(dataSource, user);
  const refreshToken = await issueRefreshToken(dataSource, user.id, refreshTokenExpiresDays);
  return { user: authenticatedUser, refreshToken };
}
