import { describe, it, expect } from 'vitest';
import { deriveCaseTypeCode, generateReferenceNumber } from '../../../../src/modules/cases/reference-number';

describe('reference number generator (placeholder format, pending real spec from Algihaz)', () => {
  it('derives a 3-letter code from a case type name', () => {
    expect(deriveCaseTypeCode('Najiz Platform Dispute')).toBe('NAJ');
  });

  it('strips non-letter characters before deriving the code', () => {
    expect(deriveCaseTypeCode('HR-Termination (Art. 80)')).toBe('HRT');
  });

  it('pads short names to 3 characters', () => {
    expect(deriveCaseTypeCode('Ab')).toBe('ABX');
  });

  it('falls back to GEN when the name has no letters', () => {
    expect(deriveCaseTypeCode('123')).toBe('GEN');
  });

  it('combines entity code, case type code, and zero-padded sequence', () => {
    expect(generateReferenceNumber('AGC', 'Najiz Platform Dispute', 123)).toBe('AGC-NAJ-000123');
  });

  it('pads the sequence to 6 digits', () => {
    expect(generateReferenceNumber('AGC', 'Internal', 1)).toBe('AGC-INT-000001');
  });
});
