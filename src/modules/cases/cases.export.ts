import type { toCaseWithSla } from './sla';
import type { CsvColumn } from '../dashboards-reports/csv';

type ExportCase = ReturnType<typeof toCaseWithSla>;

// The description is deliberately not exported.
export const CASE_EXPORT_COLUMNS: CsvColumn<ExportCase>[] = [
  { header: 'referenceNumber', value: (c) => c.referenceNumber },
  { header: 'title', value: (c) => c.title },
  { header: 'status', value: (c) => c.status },
  { header: 'priority', value: (c) => c.priority },
  { header: 'categoryId', value: (c) => c.categoryId },
  { header: 'caseTypeId', value: (c) => c.caseTypeId },
  { header: 'entityId', value: (c) => c.entityId },
  { header: 'businessUnitId', value: (c) => c.businessUnitId },
  { header: 'departmentId', value: (c) => c.departmentId },
  { header: 'assignedLegalRepId', value: (c) => c.assignedLegalRepId },
  { header: 'requesterId', value: (c) => c.requesterId },
  { header: 'createdAt', value: (c) => c.createdAt },
  { header: 'ackDueAt', value: (c) => c.ackDueAt },
  { header: 'resolutionDueAt', value: (c) => c.resolutionDueAt },
  { header: 'closedAt', value: (c) => c.closedAt },
  { header: 'slaState', value: (c) => c.slaState },
  { header: 'caseAgeHours', value: (c) => c.caseAgeHours },
  { header: 'isEscalated', value: (c) => c.isEscalated },
];
