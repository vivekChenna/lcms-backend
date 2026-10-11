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
import { CreateInformationRequests1700000011000 } from './1700000011000-create-information-requests';
import { CreateDocumentsAndComments1700000012000 } from './1700000012000-create-documents-and-comments';
import { CreateNotifications1700000013000 } from './1700000013000-create-notifications';
import { AddIntakeFieldsToCases1700000014000 } from './1700000014000-add-intake-fields-to-cases';
import { AddPasswordLinks1700000015000 } from './1700000015000-add-password-links';
import { RowLevelSecurity1700000016000 } from './1700000016000-row-level-security';

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
  CreateInformationRequests1700000011000,
  CreateDocumentsAndComments1700000012000,
  CreateNotifications1700000013000,
  AddIntakeFieldsToCases1700000014000,
  AddPasswordLinks1700000015000,
  RowLevelSecurity1700000016000,
];
