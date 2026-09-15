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
  results: Array<{ id: string; title: string | null; adesao: boolean | null; orgao: string | null }>;
}
