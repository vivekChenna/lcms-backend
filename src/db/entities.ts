import { Role } from '../modules/users/entities/role.entity';
import { User } from '../modules/users/entities/user.entity';
import { UserRole } from '../modules/users/entities/user-role.entity';
import { RefreshToken } from '../modules/auth/entities/refresh-token.entity';
import { AuditLog } from '../modules/audit/entities/audit-log.entity';

export const entities = [Role, User, UserRole, RefreshToken, AuditLog];
