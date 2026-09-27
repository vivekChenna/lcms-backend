import crypto from 'node:crypto';
import type { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Role } from '../users/entities/role.entity';
import { UserRole } from '../users/entities/user-role.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { verifyPassword } from '../../shared/password';
import { UnauthorizedError } from '../../shared/errors';
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
  if (!user || !user.isActive) {
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

export async function refreshSession(
  dataSource: DataSource,
  refreshTokenExpiresDays: number,
  presentedToken: string,
): Promise<{ user: AuthenticatedUser; refreshToken: string }> {
  const repo = dataSource.getRepository(RefreshToken);
  const existing = await repo.findOne({ where: { tokenHash: hashToken(presentedToken) } });

  if (!existing || existing.revokedAt || existing.expiresAt < new Date()) {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  existing.revokedAt = new Date();
  await repo.save(existing);

  const user = await dataSource.getRepository(User).findOne({ where: { id: existing.userId } });
  if (!user || !user.isActive) {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  const authenticatedUser = await loadAuthenticatedUser(dataSource, user);
  const refreshToken = await issueRefreshToken(dataSource, user.id, refreshTokenExpiresDays);
  return { user: authenticatedUser, refreshToken };
}
