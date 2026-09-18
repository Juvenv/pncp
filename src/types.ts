export type JsonObject = Record<string, unknown>;

export interface SearchSummary {
  pesquisa_id: string;
  termos: string[];
  filtros: JsonObject;
  status: string;
  next_page: number;
  coverage: string;
  reason: string | null;
  unique_records: number;
  filtros_efetivos: Record<string, string> | null;
  filtros_nao_aplicados: string[];
  consultas: import('./search.js').QueryProgress[];
  results_returned: number;
  results_truncated: boolean;
  escopo_cobertura: string;
  pendencias: string[];
  results: Array<{ id: string; title: string | null; adesao: boolean | null; orgao: string | null }>;
}
