import type { JsonObject } from './types.js';

export function rows(payload: unknown): JsonObject[] {
  if (Array.isArray(payload) && payload.every((item) => item !== null && typeof item === 'object')) {
    return payload as JsonObject[];
  }
  if (payload !== null && typeof payload === 'object') {
    const object = payload as JsonObject;
    for (const key of ['items', 'data']) {
      const value = object[key];
      if (Array.isArray(value) && value.every((item) => item !== null && typeof item === 'object')) {
        return value as JsonObject[];
      }
    }
  }
  throw new Error('Formato de resposta não reconhecido; não tratar como lista vazia');
}

export function stableId(row: JsonObject): string {
  for (const key of ['numero_controle_pncp', 'numeroControlePNCPAta', 'numeroControlePNCP', 'id']) {
    const value = row[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  throw new Error('Registro sem identificador estável');
}

export function field(row: JsonObject, ...keys: string[]): unknown {
  for (const key of keys) if (key in row) return row[key];
  return null;
}

export function matchesAdhesion(row: JsonObject, expected: boolean | null = null): boolean {
  return expected === null || field(row, 'permite_adesao', 'possibilidadeAdesao') === expected;
}
