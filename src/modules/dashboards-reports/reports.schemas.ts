import { z } from 'zod';
import { CASE_PRIORITIES, CASE_STATUSES } from '../cases/cases.schemas';

export const reportQuerySchema = z
  .object({
    status: z.enum(CASE_STATUSES).optional(),
    priority: z.enum(CASE_PRIORITIES).optional(),
    categoryId: z.string().uuid().optional(),
    caseTypeId: z.string().uuid().optional(),
    entityId: z.string().uuid().optional(),
    businessUnitId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    assignedLegalRepId: z.string().uuid().optional(),
    createdFrom: z.coerce.date().optional(),
    createdTo: z.coerce.date().optional(),
  })
  .refine((query) => !query.createdFrom || !query.createdTo || query.createdFrom <= query.createdTo, {
    message: 'createdFrom must not be after createdTo',
    path: ['createdFrom'],
  });

export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const slaComplianceResponseSchema = z.object({
  closedOnTime: z.number(),
  closedLate: z.number(),
  openOnTrack: z.number(),
  openAtRisk: z.number(),
  openBreached: z.number(),
  compliancePercent: z.number().nullable(),
});

export const ageingResponseSchema = z.array(z.object({ bucket: z.enum(['0-7', '8-30', '31-90', '91+']), count: z.number() }));

export const volumeByCategoryResponseSchema = z.array(
  z.object({ categoryId: z.string(), categoryName: z.string(), caseTypeId: z.string(), caseTypeName: z.string(), count: z.number() }),
);

export const volumeByOrganisationResponseSchema = z.array(
  z.object({
    entityId: z.string(),
    entityName: z.string(),
    businessUnitId: z.string().nullable(),
    businessUnitName: z.string().nullable(),
    departmentId: z.string(),
    departmentName: z.string(),
    count: z.number(),
  }),
);

export const repWorkloadResponseSchema = z.array(
  z.object({
    legalRepId: z.string(),
    fullName: z.string(),
    openCount: z.number(),
    awaitingAcceptanceCount: z.number(),
    overdueCount: z.number(),
  }),
);
