import { CreateUsersAndRoles1700000001000 } from './1700000001000-create-users-and-roles';
import { CreateAuditLog1700000002000 } from './1700000002000-create-audit-log';
import { CreateSimpleMasterData1700000003000 } from './1700000003000-create-simple-master-data';
import { CreateEntitiesAndBusinessUnits1700000004000 } from './1700000004000-create-entities-and-business-units';
import { CreateCaseTypes1700000005000 } from './1700000005000-create-case-types';
import { CreateRoutingRules1700000006000 } from './1700000006000-create-routing-rules';
import { AddUserOrgFks1700000007000 } from './1700000007000-add-user-org-fks';
import { AddMasterDataCompositeUniques1700000008000 } from './1700000008000-add-master-data-composite-uniques';
import { AddRefreshTokenHashIndex1700000009000 } from './1700000009000-add-refresh-token-hash-index';
import { CreateCases1700000010000 } from './1700000010000-create-cases';

export const migrations = [
  CreateUsersAndRoles1700000001000,
  CreateAuditLog1700000002000,
  CreateSimpleMasterData1700000003000,
  CreateEntitiesAndBusinessUnits1700000004000,
  CreateCaseTypes1700000005000,
  CreateRoutingRules1700000006000,
  AddUserOrgFks1700000007000,
  AddMasterDataCompositeUniques1700000008000,
  AddRefreshTokenHashIndex1700000009000,
  CreateCases1700000010000,
];
