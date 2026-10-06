// test/unit/modules/notifications/to-single-line.test.ts
import { describe, it, expect } from 'vitest';
import { toSingleLine } from '../../../../src/modules/notifications/notifications.events';

describe('toSingleLine', () => {
  it('collapses newlines, tabs and runs of spaces into single spaces and trims', () => {
    expect(toSingleLine('  Case\r\nX-Evil: 1\t\tdone  ')).toBe('Case X-Evil: 1 done');
  });

  it('caps the length at 200 characters', () => {
    expect(toSingleLine('a'.repeat(500))).toHaveLength(200);
  });

  it('keeps non-ASCII text intact', () => {
    expect(toSingleLine('قضية ٢٠٢٦')).toBe('قضية ٢٠٢٦');
  });
});
