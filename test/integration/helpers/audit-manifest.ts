import type { FastifyInstance } from 'fastify';

// Every registered POST/PATCH/PUT/DELETE route must appear in exactly one of
// these maps (audit-coverage.test.ts checks it). buildTestApp turns
// AUDITED_ROUTES into a runtime check: a 2xx response on one of these routes
// that wrote no audit_log row becomes a 500 AUDIT_COVERAGE_MISSING.

export const EXEMPT_ROUTES: Record<string, string> = {
  'POST /auth/login': 'Authentication events are not audit events in the BRD (AT-01..AT-05, AU-14).',
  'POST /auth/refresh': 'Authentication events are not audit events in the BRD (AT-01..AT-05, AU-14).',
  'POST /auth/logout': 'Authentication events are not audit events in the BRD (AT-01..AT-05, AU-14).',
  'POST /auth/change-password': 'Authentication events are not audit events in the BRD (AT-01..AT-05, AU-14).',
  'POST /auth/forgot-password': 'Public and deliberately silent: an unknown address must look identical to a real one, so it writes nothing; a request for a real account is audited as user.password_link_requested from the background send.',
  'PATCH /notifications/:id/read': 'Read state of a notification is not a business event.',
  'PATCH /notifications/read-all': 'Read state of notifications is not a business event.',
};

// Values document the audit action(s) the route's service writes.
export const AUDITED_ROUTES: Record<string, string> = {
  'POST /cases': 'case.submitted',
  'PATCH /cases/:id': 'case.updated',
  'PATCH /cases/:id/priority': 'case.priority_changed',
  'PATCH /cases/:id/assign': 'case.assigned',
  'PATCH /cases/:id/accept': 'case.accepted',
  'PATCH /cases/:id/reject': 'case.rejected',
  'PATCH /cases/:id/close': 'case.closed',
  'PATCH /cases/:id/escalate': 'case.escalated | case.escalation_cleared',
  'POST /cases/:id/comments': 'comment.created',
  'PATCH /comments/:id': 'comment.edited',
  'DELETE /comments/:id': 'comment.deleted',
  'POST /cases/:id/documents': 'document.uploaded',
  'POST /documents/:id/versions': 'document.version_uploaded',
  'POST /information-requests/:id/attachments': 'document.uploaded',
  'DELETE /documents/:id': 'document.deleted',
  'POST /cases/:id/information-requests': 'info_request.raised',
  'POST /information-requests/:id/respond': 'info_request.answered',
  'POST /information-requests/:id/reopen': 'info_request.reopened',
  'POST /users': 'user.created',
  'POST /users/:id/send-password-link': 'user.password_link_sent',
  'POST /auth/set-password': 'user.password_set',
  'PATCH /users/:id': 'user.updated',
  'PATCH /users/:id/role': 'user.role_changed',
  'PATCH /users/:id/activate': 'user.activated',
  'PATCH /users/:id/deactivate': 'user.deactivated',
  'POST /entities': 'entity.created',
  'PATCH /entities/:id': 'entity.updated',
  'POST /business-units': 'business_unit.created',
  'PATCH /business-units/:id': 'business_unit.updated',
  'POST /case-types': 'case_type.created',
  'PATCH /case-types/:id': 'case_type.updated',
  'POST /routing-rules': 'routing_rule.created',
  'PATCH /routing-rules/:id': 'routing_rule.updated',
  'POST /departments': 'department.created',
  'PATCH /departments/:id': 'department.updated',
  'POST /case-categories': 'case_category.created',
  'PATCH /case-categories/:id': 'case_category.updated',
  'POST /closure-outcomes': 'closure_outcome.created',
  'PATCH /closure-outcomes/:id': 'closure_outcome.updated',
};

const registeredMutatingRoutes = new WeakMap<FastifyInstance, Set<string>>();

// Called by buildTestApp with the set its onRoute hook fills.
export function registerMutatingRoutes(app: FastifyInstance, routes: Set<string>): void {
  registeredMutatingRoutes.set(app, routes);
}

export function getRegisteredMutatingRoutes(app: FastifyInstance): string[] {
  return [...(registeredMutatingRoutes.get(app) ?? [])];
}
