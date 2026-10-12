import { Case } from './entities/case.entity';
import { CaseCategory } from '../master-data/entities/case-category.entity';
import { CaseType } from '../master-data/entities/case-type.entity';
import { Department } from '../master-data/entities/department.entity';
import { OrgEntity } from '../master-data/entities/org-entity.entity';
import { BusinessUnit } from '../master-data/entities/business-unit.entity';
import { loadNamesById, loadUserNames, type NameSource } from '../../shared/name-lookup';

export type CaseNameFields = {
  requesterName: string | null;
  requesterDesignation: string | null;
  assignedLegalRepName: string | null;
  assignedLegalRepRole: string | null;
  assignedLegalRepDesignation: string | null;
  categoryName: string | null;
  caseTypeName: string | null;
  departmentName: string | null;
  entityName: string | null;
  businessUnitName: string | null;
};

export async function withCaseNames<T extends Case>(source: NameSource, rows: T[]): Promise<Array<T & CaseNameFields>> {
  const [users, categories, types, departments, entities, units] = await Promise.all([
    loadUserNames(source, rows.flatMap((row) => [row.requesterId, row.assignedLegalRepId])),
    loadNamesById(source, CaseCategory, rows.map((row) => row.categoryId)),
    loadNamesById(source, CaseType, rows.map((row) => row.caseTypeId)),
    loadNamesById(source, Department, rows.map((row) => row.departmentId)),
    loadNamesById(source, OrgEntity, rows.map((row) => row.entityId)),
    loadNamesById(source, BusinessUnit, rows.map((row) => row.businessUnitId)),
  ]);
  return rows.map((row) => {
    const requester = users.get(row.requesterId);
    const assignee = row.assignedLegalRepId ? users.get(row.assignedLegalRepId) : undefined;
    return {
      ...row,
      requesterName: requester?.fullName ?? null,
      requesterDesignation: requester?.designation ?? null,
      assignedLegalRepName: assignee?.fullName ?? null,
      assignedLegalRepRole: assignee?.role ?? null,
      assignedLegalRepDesignation: assignee?.designation ?? null,
      categoryName: categories.get(row.categoryId) ?? null,
      caseTypeName: types.get(row.caseTypeId) ?? null,
      departmentName: departments.get(row.departmentId) ?? null,
      entityName: entities.get(row.entityId) ?? null,
      businessUnitName: row.businessUnitId ? (units.get(row.businessUnitId) ?? null) : null,
    };
  });
}
