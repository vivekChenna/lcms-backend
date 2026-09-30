import { Role } from '../modules/users/entities/role.entity';
import { User } from '../modules/users/entities/user.entity';
import { UserRole } from '../modules/users/entities/user-role.entity';
import { RefreshToken } from '../modules/auth/entities/refresh-token.entity';
import { AuditLog } from '../modules/audit/entities/audit-log.entity';
import { Department } from '../modules/master-data/entities/department.entity';
import { CaseCategory } from '../modules/master-data/entities/case-category.entity';
import { ClosureOutcome } from '../modules/master-data/entities/closure-outcome.entity';
import { OrgEntity } from '../modules/master-data/entities/org-entity.entity';
import { BusinessUnit } from '../modules/master-data/entities/business-unit.entity';
import { CaseType } from '../modules/master-data/entities/case-type.entity';
import { RoutingRule } from '../modules/master-data/entities/routing-rule.entity';
import { Case } from '../modules/cases/entities/case.entity';

export const entities = [
  Role, User, UserRole, RefreshToken, AuditLog,
  Department, CaseCategory, ClosureOutcome, OrgEntity, BusinessUnit, CaseType, RoutingRule,
  Case,
];
