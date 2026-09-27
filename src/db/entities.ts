import { Role } from '../modules/users/entities/role.entity';
import { User } from '../modules/users/entities/user.entity';
import { UserRole } from '../modules/users/entities/user-role.entity';
import { RefreshToken } from '../modules/auth/entities/refresh-token.entity';

export const entities = [Role, User, UserRole, RefreshToken];
