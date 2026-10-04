// test/unit/modules/cases/state-machine.test.ts
import { describe, it, expect } from 'vitest';
import { canTransition, assertTransition } from '../../../../src/modules/cases/state-machine';
import { ConflictError } from '../../../../src/shared/errors';

describe('case state machine', () => {
  it('allows Submitted -> Assigned', () => {
    expect(canTransition('Submitted', 'Assigned')).toBe(true);
  });

  it('allows Assigned -> In Progress (accept)', () => {
    expect(canTransition('Assigned', 'In Progress')).toBe(true);
  });

  it('allows Assigned -> Submitted (reject)', () => {
    expect(canTransition('Assigned', 'Submitted')).toBe(true);
  });

  it('allows reassignment from any open status back to Assigned', () => {
    expect(canTransition('Assigned', 'Assigned')).toBe(true);
    expect(canTransition('In Progress', 'Assigned')).toBe(true);
    expect(canTransition('Waiting on Input', 'Assigned')).toBe(true);
  });

  it('allows In Progress -> Waiting on Input and back', () => {
    expect(canTransition('In Progress', 'Waiting on Input')).toBe(true);
    expect(canTransition('Waiting on Input', 'In Progress')).toBe(true);
  });

  it('allows In Progress -> Closed', () => {
    expect(canTransition('In Progress', 'Closed')).toBe(true);
  });

  it('rejects Submitted -> Closed directly', () => {
    expect(canTransition('Submitted', 'Closed')).toBe(false);
  });

  it('rejects any transition out of Closed', () => {
    expect(canTransition('Closed', 'Assigned')).toBe(false);
    expect(canTransition('Closed', 'In Progress')).toBe(false);
  });

  it('assertTransition throws ConflictError for an invalid transition', () => {
    expect(() => assertTransition('Submitted', 'Closed')).toThrow(ConflictError);
  });

  it('assertTransition does not throw for a valid transition', () => {
    expect(() => assertTransition('Submitted', 'Assigned')).not.toThrow();
  });
});
