import { Role } from '../modules/users/entities/role.entity';
import { User } from '../modules/users/entities/user.entity';
import { UserRole } from '../modules/users/entities/user-role.entity';
import { RefreshToken } from '../modules/auth/entities/refresh-token.entity';
import { AuditLog } from '../modules/audit/entities/audit-log.entity';
import { Department } from '../modules/master-data/entities/department.entity';
import { CaseCategory } from '../modules/master-data/entities/case-category.entity';
import { ClosureOutcome } from '../modules/master-data/entities/closure-outcome.entity';

export const entities = [Role, User, UserRole, RefreshToken, AuditLog, Department, CaseCategory, ClosureOutcome];
