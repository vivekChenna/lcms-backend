import { z } from 'zod';
import { CASE_PRIORITIES, CASE_STATUSES, SLA_STATES } from '../cases/cases.schemas';

export const panelItemSchema = z.object({
  id: z.string(),
  referenceNumber: z.string(),
  title: z.string(),
  priority: z.enum(CASE_PRIORITIES),
  status: z.enum(CASE_STATUSES),
  resolutionDueAt: z.string(),
  slaState: z.enum(SLA_STATES),
  assignedLegalRepName: z.string().nullable(),
  assignedLegalRepDesignation: z.string().nullable(),
});

const countSchema = z.number();

export const dashboardResponseSchema = z.object({
  tiles: z.object({
    total: countSchema,
    open: countSchema,
    awaitingAcceptance: countSchema,
    waitingOnInput: countSchema,
    overdue: countSchema,
    onTime: countSchema,
    closed: countSchema,
    assignedToMe: countSchema,
    unassigned: countSchema,
  }),
  filters: z.record(z.string(), z.record(z.string(), z.string())),
  byStatus: z.array(z.object({ status: z.enum(CASE_STATUSES), count: countSchema })),
  myAssignedCases: z.array(panelItemSchema).optional(),
  managerPanels: z
    .object({
      openCaseloadByRep: z.array(
        z.object({ legalRepId: z.string(), fullName: z.string(), openCount: countSchema, overdueCount: countSchema }),
      ),
      unassigned: z.object({ count: countSchema, items: z.array(panelItemSchema) }),
      awaitingAcceptance: z.object({ count: countSchema, items: z.array(panelItemSchema) }),
    })
    .optional(),
});

export type DashboardResult = z.infer<typeof dashboardResponseSchema>;
