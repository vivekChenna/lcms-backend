import { z } from 'zod';
import { paginationQuerySchema } from '../../shared/pagination';

export const CASE_STATUSES = ['Submitted', 'Assigned', 'In Progress', 'Waiting on Input', 'Closed'] as const;
export const CASE_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export const SLA_STATES = ['on_track', 'at_risk', 'breached', 'met'] as const;

export const createCaseBodySchema = z.object({
  title: z.string().min(1),
  description: z.string().min(20),
  declarationConfirmed: z.literal(true),
  categoryId: z.string().uuid(),
  caseTypeId: z.string().uuid(),
  departmentId: z.string().uuid(),
  // Optional at the HTTP body level: a requester's entity/business unit are
  // pre-filled server-side from their profile and non-editable (PR-02), so
  // their request never includes entityId. Other submitter roles (legal_rep,
  // admin) provide it directly in the body; submitCase (Task 9) enforces
  // that it's present for those roles.
  entityId: z.string().uuid().optional(),
  businessUnitId: z.string().uuid().optional(),
  priority: z.enum(CASE_PRIORITIES).default('P3'),
});

export const updateCaseBodySchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(20).optional(),
  categoryId: z.string().uuid().optional(),
  caseTypeId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
});

export const updatePriorityBodySchema = z.object({
  priority: z.enum(CASE_PRIORITIES),
});

export const assignCaseBodySchema = z.object({
  targetLegalRepId: z.string().uuid(),
});

export const rejectAssignmentBodySchema = z.object({
  reason: z.string().min(3),
});

export const escalateCaseBodySchema = z
  .object({
    isEscalated: z.boolean(),
    reason: z.string().min(1).optional(),
  })
  .refine((v) => !v.isEscalated || (v.reason !== undefined && v.reason.length > 0), {
    message: 'reason is required when escalating',
    path: ['reason'],
  });

export const closeCaseBodySchema = z.object({
  confirm: z.literal(true),
  closureSummary: z.string().min(1),
  closureOutcomeId: z.string().uuid(),
});

export const caseIdParamsSchema = z.object({ id: z.string().uuid() });

export const caseListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(CASE_STATUSES).optional(),
  priority: z.enum(CASE_PRIORITIES).optional(),
  categoryId: z.string().uuid().optional(),
  caseTypeId: z.string().uuid().optional(),
  entityId: z.string().uuid().optional(),
  businessUnitId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  assignedLegalRepId: z.string().uuid().optional(),
  search: z.string().optional(),
  slaState: z.enum(SLA_STATES).optional(),
  open: z.literal('true').transform(() => true).optional(),
});

export const caseResponseSchema = z.object({
  id: z.string(),
  referenceNumber: z.string(),
  title: z.string(),
  description: z.string(),
  declarationConfirmed: z.boolean(),
  categoryId: z.string(),
  caseTypeId: z.string(),
  departmentId: z.string(),
  entityId: z.string(),
  businessUnitId: z.string().nullable(),
  priority: z.enum(CASE_PRIORITIES),
  status: z.enum(CASE_STATUSES),
  isEscalated: z.boolean(),
  escalationReason: z.string().nullable(),
  waitingOnReason: z.string().nullable(),
  requesterId: z.string(),
  assignedLegalRepId: z.string().nullable(),
  assignmentAcceptedAt: z.string().nullable(),
  ackDueAt: z.string(),
  resolutionDueAt: z.string(),
  closureSummary: z.string().nullable(),
  closureOutcomeId: z.string().nullable(),
  closedById: z.string().nullable(),
  closedAt: z.string().nullable(),
  slaState: z.enum(SLA_STATES),
  caseAgeHours: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const caseListResponseSchema = z.object({
  items: z.array(caseResponseSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
