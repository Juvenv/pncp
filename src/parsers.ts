import type { JsonObject } from './types.js';
export function rows(payload: unknown): JsonObject[] {
  if (Array.isArray(payload) && payload.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))) {
    return payload as JsonObject[];
  }
  if (payload !== null && typeof payload === 'object') {
    const object = payload as JsonObject;
    for (const key of ['items', 'data']) {
      const value = object[key];
      if (Array.isArray(value) && value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))) {
        return value as JsonObject[];
      }
    }
  }
  throw new Error('Formato de resposta não reconhecido; não tratar como lista vazia');
}
export function stableId(row: JsonObject): string {
  for (const key of ['numero_controle_pncp', 'numeroControlePNCPAta', 'numeroControlePNCP', 'id']) {
    const value = row[key];
    if (typeof value === 'string' && value.trim())
      return value.trim();
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      return String(value);
  }
  throw new Error('Registro sem identificador estável');
}
export function field(row: JsonObject, ...keys: string[]): unknown {
  for (const key of keys)
    if (key in row)
      return row[key];
  return null;
}
export function matchesAdhesion(row: JsonObject, expected: boolean | null = null): boolean {
  return expected === null || field(row, 'permite_adesao', 'possibilidadeAdesao') === expected;
}
export function adhesion(row: JsonObject): boolean | null {
  const value = field(row, 'permite_adesao', 'possibilidadeAdesao');
  if (value !== null && value !== true && value !== false)
    throw new Error('Adesão inválida: esperado boolean ou null; cadastro não autoriza adesão');
  return value;
}
export function validateRecords(records: JsonObject[]): void {
  const ids = new Set<string>();
  for (const record of records) {
    const id = stableId(record);
    adhesion(record);
    if (ids.has(id))
      throw new Error('Resposta contém identificadores duplicados na mesma página');
    ids.add(id);
  }
}
