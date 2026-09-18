import type { JsonObject } from './types.js';

const spheres: Record<string, string> = { federal: 'F', estadual: 'E', municipal: 'M', distrital: 'D', 'não se aplica': 'N' };
export function searchFilters(filters: JsonObject): Record<string, string> {
  const result: Record<string, string> = { tipos_documento: 'ata', ordenacao: '-data' };
  const status = filters.status ?? filters.situacao;
  if (status != null) {
    if (typeof status !== 'string' || !['vigente', 'nao_vigente', 'todos'].includes(status)) throw new Error('Status inválido: use vigente, nao_vigente ou todos');
    if (status !== 'todos') result.status = status;
  }
  const sphere = filters.esferas ?? filters.esfera;
  if (sphere != null) {
    if (typeof sphere !== 'string') throw new Error('Informe uma esfera por pesquisa');
    const code = spheres[sphere.toLowerCase()] ?? sphere.toUpperCase();
    if (!['F', 'E', 'M', 'D', 'N'].includes(code)) throw new Error('Esfera inválida');
    result.esferas = code;
  }
  if (filters.tipo_documento != null && !['ata', 'ata de registro de preços'].includes(String(filters.tipo_documento))) throw new Error('Esta ferramenta pesquisa somente atas');
  return result;
}

export function pendingFilters(filters: JsonObject): string[] {
  const supported = new Set(['status', 'situacao', 'esferas', 'esfera', 'modo', 'limites', '_search_version', 'tipo_documento']);
  return Object.keys(filters).filter(key => !supported.has(key));
}

export interface QueryProgress {
  termo: string;
  pagina: number;
  recebidos: number;
  total: number | null;
  completa: boolean;
  url: string;
}

export function queryProgress(payload: unknown, count: number, size: number, previous: number): Pick<QueryProgress, 'recebidos' | 'total' | 'completa'> {
  const object = payload as JsonObject;
  const total = typeof object?.total === 'number' && Number.isInteger(object.total) && object.total >= 0 ? object.total : null;
  const recebidos = previous + count;
  if (total !== null) {
    if (count === 0 && recebidos < total) throw new Error('Página vazia antes de alcançar o total informado pelo PNCP');
    return { total, recebidos, completa: recebidos >= total };
  }
  if (typeof object?.paginasRestantes === 'number') return { total, recebidos, completa: object.paginasRestantes === 0 };
  if (typeof object?.paginasRestantes === 'boolean') return { total, recebidos, completa: !object.paginasRestantes };
  return { total, recebidos, completa: count < size };
}
