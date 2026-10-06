import { describe, it, expect } from 'vitest';
import { exportFilename, toCsv, toCsvCell, DEFAULT_EXPORT_ROW_CAP } from '../../../../src/modules/dashboards-reports/csv';

describe('toCsvCell', () => {
  it('renders null and undefined as empty', () => {
    expect(toCsvCell(null)).toBe('');
    expect(toCsvCell(undefined)).toBe('');
  });

  it('renders dates as ISO 8601, numbers and booleans plainly', () => {
    expect(toCsvCell(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(toCsvCell(42)).toBe('42');
    expect(toCsvCell(-3.5)).toBe('-3.5');
    expect(toCsvCell(true)).toBe('true');
  });

  it('renders objects as compact JSON, quoted because of the commas and quotes', () => {
    expect(toCsvCell({ a: 1, b: 'x' })).toBe('"{""a"":1,""b"":""x""}"');
  });

  it('quotes cells containing commas, quotes or line breaks and doubles embedded quotes', () => {
    expect(toCsvCell('a,b')).toBe('"a,b"');
    expect(toCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(toCsvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(toCsvCell('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tcmd', '\rcmd'])('neutralises the formula-looking string %j', (input) => {
    const cell = toCsvCell(input);
    expect(cell.replace(/^"/, '')[0]).toBe("'");
  });

  it('prefixes a dangerous string that also needs quoting', () => {
    expect(toCsvCell('=HYPERLINK("http://evil","x")')).toBe('"\'=HYPERLINK(""http://evil"",""x"")"');
  });

  it('never prefixes real numbers, so negative numbers stay numeric', () => {
    expect(toCsvCell(-1)).toBe('-1');
  });

  it('keeps Arabic text intact', () => {
    expect(toCsvCell('قضية عقد ٢٠٢٦')).toBe('قضية عقد ٢٠٢٦');
  });
});

describe('toCsv', () => {
  it('starts with a BOM, then the header, then CRLF-terminated rows', () => {
    const csv = toCsv([{ a: 'x', b: 1 }, { a: 'y,z', b: 2 }], [
      { header: 'A', value: (row) => row.a },
      { header: 'B', value: (row) => row.b },
    ]);
    expect(csv).toBe('﻿A,B\r\nx,1\r\n"y,z",2\r\n');
  });

  it('with no rows still emits the BOM and the header', () => {
    expect(toCsv([], [{ header: 'A', value: () => '' }])).toBe('﻿A\r\n');
  });

  it('sanitises header cells too', () => {
    expect(toCsv([], [{ header: 'Total, all', value: () => '' }])).toBe('﻿"Total, all"\r\n');
  });
});

describe('exportFilename and the default cap', () => {
  it('uses the UTC date', () => {
    expect(exportFilename('cases', new Date('2026-10-08T23:59:59.000Z'))).toBe('cases-20261008.csv');
  });

  it('defaults the cap to 10 000 rows', () => {
    expect(DEFAULT_EXPORT_ROW_CAP).toBe(10_000);
  });
});
