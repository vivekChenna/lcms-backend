import { describe, it, expect } from 'vitest';
import {
  raiseInformationRequestBodySchema,
  respondInformationRequestBodySchema,
  reopenInformationRequestBodySchema,
} from '../../../../src/modules/information-requests/information-requests.schemas';

describe('information-request schemas', () => {
  it('accepts a valid raise body without a dueDate', () => {
    const result = raiseInformationRequestBodySchema.safeParse({
      subject: 'Need clarification',
      requirementDescription: 'Please confirm the affected business unit.',
      responderId: '11111111-1111-4111-8111-111111111111',
    });
    expect(result.success).toBe(true);
  });

  it('coerces a valid ISO dueDate string to a Date', () => {
    const result = raiseInformationRequestBodySchema.parse({
      subject: 'Need clarification',
      requirementDescription: 'Please confirm the affected business unit.',
      responderId: '11111111-1111-4111-8111-111111111111',
      dueDate: '2026-12-01T00:00:00.000Z',
    });
    expect(result.dueDate).toBeInstanceOf(Date);
  });

  it('rejects a raise body missing requirementDescription', () => {
    const result = raiseInformationRequestBodySchema.safeParse({
      subject: 'Need clarification',
      responderId: '11111111-1111-4111-8111-111111111111',
    });
    expect(result.success).toBe(false);
  });

  it('requires non-empty responseText', () => {
    expect(respondInformationRequestBodySchema.safeParse({ responseText: '' }).success).toBe(false);
    expect(respondInformationRequestBodySchema.safeParse({ responseText: 'Here is the clarification.' }).success).toBe(true);
  });

  it('requires a non-empty comment to reopen (VC-11)', () => {
    expect(reopenInformationRequestBodySchema.safeParse({ comment: '' }).success).toBe(false);
    expect(reopenInformationRequestBodySchema.safeParse({ comment: 'This does not answer the question.' }).success).toBe(true);
  });
});
