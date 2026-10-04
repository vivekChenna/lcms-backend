// Placeholder format pending the real `Group-Entity-Type-Reference ID`
// scheme from Algihaz (VC-06/AU-01). Isolated here as one swappable
// function so the final format can drop in without touching call sites.
export function deriveCaseTypeCode(caseTypeName: string): string {
  const letters = caseTypeName.toUpperCase().replace(/[^A-Z]/g, '');
  if (letters.length === 0) {
    return 'GEN';
  }
  return letters.slice(0, 3).padEnd(3, 'X');
}

export function generateReferenceNumber(entityCode: string, caseTypeName: string, sequence: number): string {
  const caseTypeCode = deriveCaseTypeCode(caseTypeName);
  return `${entityCode}-${caseTypeCode}-${String(sequence).padStart(6, '0')}`;
}
