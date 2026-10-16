import type { JsonObject } from './types.js';
const spheres: Record<string, string> = { federal: 'F', estadual: 'E', municipal: 'M', distrital: 'D', 'não se aplica': 'N' };
export function searchFilters(filters: JsonObject): Record<string, string> {
  if (filters.status != null && filters.situacao != null && filters.status !== filters.situacao)
    throw new Error('Aliases status/situacao contraditórios');
  if (filters.esferas != null && filters.esfera != null) {
    const normalize = (value: unknown) => typeof value === 'string' ? spheres[value.toLowerCase()] ?? value.toUpperCase() : value;
    if (normalize(filters.esferas) !== normalize(filters.esfera))
      throw new Error('Aliases esfera/esferas contraditórios');
  }
  const result: Record<string, string> = { tipos_documento: 'ata', ordenacao: '-data' };
  const status = filters.status ?? filters.situacao;
  if (status != null) {
    if (typeof status !== 'string' || !['vigente', 'nao_vigente', 'todos'].includes(status))
      throw new Error('Status inválido: use vigente, nao_vigente ou todos');
    if (status !== 'todos')
      result.status = status;
  }
  const sphere = filters.esferas ?? filters.esfera;
  if (sphere != null) {
    if (typeof sphere !== 'string')
      throw new Error('Informe uma esfera por pesquisa');
    const code = spheres[sphere.toLowerCase()] ?? sphere.toUpperCase();
    if (!['F', 'E', 'M', 'D', 'N'].includes(code))
      throw new Error('Esfera inválida');
    result.esferas = code;
  }
  if (filters.tipo_documento != null && !['ata', 'ata de registro de preços'].includes(String(filters.tipo_documento)))
    throw new Error('Esta ferramenta pesquisa somente atas');
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
  erro?: unknown;
}
export function queryProgress(payload: unknown, count: number, size: number, previous: number): Pick<QueryProgress, 'recebidos' | 'total' | 'completa'> {
  const object = payload as JsonObject;
  if (object && typeof object === 'object' && 'total' in object && (typeof object.total !== 'number' || !Number.isSafeInteger(object.total) || object.total < 0))
    throw new Error('Total inválido no contrato da resposta PNCP');
  if (object?.paginasRestantes !== undefined && typeof object.paginasRestantes !== 'boolean' && !(typeof object.paginasRestantes === 'number' && Number.isSafeInteger(object.paginasRestantes) && object.paginasRestantes >= 0))
    throw new Error('paginasRestantes inválido');
  const total = typeof object?.total === 'number' && Number.isInteger(object.total) && object.total >= 0 ? object.total : null;
  const recebidos = previous + count;
  if (total !== null) {
    if (recebidos > total)
      throw new Error('Recebidos excedem o total informado pelo PNCP');
    if (count === 0 && recebidos < total)
      throw new Error('Página vazia antes de alcançar o total informado pelo PNCP');
    return { total, recebidos, completa: recebidos >= total };
  }
  if (typeof object?.paginasRestantes === 'number')
    return { total, recebidos, completa: object.paginasRestantes === 0 };
  if (typeof object?.paginasRestantes === 'boolean')
    return { total, recebidos, completa: !object.paginasRestantes };
  return { total, recebidos, completa: count < size };
}
