import { CreateUsersAndRoles1700000001000 } from './1700000001000-create-users-and-roles';
import { CreateAuditLog1700000002000 } from './1700000002000-create-audit-log';
import { CreateSimpleMasterData1700000003000 } from './1700000003000-create-simple-master-data';
import { CreateEntitiesAndBusinessUnits1700000004000 } from './1700000004000-create-entities-and-business-units';
import { CreateCaseTypes1700000005000 } from './1700000005000-create-case-types';

export const migrations = [
  CreateUsersAndRoles1700000001000,
  CreateAuditLog1700000002000,
  CreateSimpleMasterData1700000003000,
  CreateEntitiesAndBusinessUnits1700000004000,
  CreateCaseTypes1700000005000,
];
