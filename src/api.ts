import { HttpClient } from './http.js';

export class PncpApi {
  static readonly searchUrl = 'https://pncp.gov.br/api/search/';
  static readonly consultaUrl = 'https://pncp.gov.br/api/consulta/v1';
  static readonly detalhesUrl = 'https://pncp.gov.br/api/pncp/v1';
  constructor(readonly http = new HttpClient()) {}
  search(term: string, page: number, pageSize: number, filters: Record<string, string> = {}): Promise<unknown> {
    return this.http.json(PncpApi.searchUrl, { ...filters, tipos_documento: 'ata', ordenacao: '-data', q: term || undefined, pagina: page, tam_pagina: pageSize }, 'busca textual');
  }
  updated(start: string, end: string, page: number, pageSize: number): Promise<unknown> { return this.http.json(`${PncpApi.consultaUrl}/atas/atualizacao`, { dataInicial: start, dataFinal: end, pagina: page, tamanhoPagina: pageSize }, 'atas por atualização'); }
  purchase(cnpj: string, year: string, sequence: string): Promise<unknown> { return this.http.json(`${PncpApi.consultaUrl}/orgaos/${encodeURIComponent(cnpj)}/compras/${encodeURIComponent(year)}/${encodeURIComponent(sequence)}`, {}, 'contratação'); }
  resource(cnpj: string, year: string, sequence: string, resource: string, ata?: string, page = 1, pageSize = 10): Promise<unknown> {
    const base = `${PncpApi.detalhesUrl}/orgaos/${encodeURIComponent(cnpj)}/compras/${encodeURIComponent(year)}/${encodeURIComponent(sequence)}${ata ? `/atas/${encodeURIComponent(ata)}` : ''}/${resource}`;
    return this.http.json(base, ['itens', 'atas', 'arquivos'].includes(resource) ? { pagina: page, tamanhoPagina: pageSize } : {}, resource);
  }
}
