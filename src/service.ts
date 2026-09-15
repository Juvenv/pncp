import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PncpApi } from './api.js';
import { evidenceSnippets, extractPdf, saveDocument } from './documents.js';
import { rows } from './parsers.js';
import { Store } from './store.js';
import type { JsonObject } from './types.js';

export class Service {
  readonly store: Store;
  constructor(readonly dataDir = process.env.PNCP_DATA_DIR ?? join(process.cwd(), 'dados'), readonly api = new PncpApi()) {
    mkdirSync(dataDir, { recursive: true });
    this.store = new Store(join(dataDir, 'pncp.sqlite3'));
  }
  close(): void { this.store.close(); }
  start(terms: string[] = [], filters: JsonObject = {}, mode = 'busca_rapida', limits: JsonObject = {}): JsonObject {
    const id = this.store.start(terms, { ...filters, modo: mode, limites: limits });
    return { ...this.store.summary(id), interpretação: { termos_pesquisados: terms, filtros: filters, filtros_tecnicos_locais: true, cobertura_inicial: 'nenhuma página coletada' } };
  }
  async collect(id: string, pageSize = 10): Promise<JsonObject> {
    const current = this.store.summary(id, 0); const filters = current.filtros;
    try {
      const payload = await this.api.search(current.termos.length ? current.termos : undefined, current.next_page, pageSize, typeof filters.status === 'string' ? filters.status : undefined);
      const data = rows(payload); this.store.ingest(id, current.next_page, payload);
      const more = data.length >= pageSize || (payload !== null && typeof payload === 'object' && Boolean((payload as JsonObject).paginasRestantes));
      this.store.setStatus(id, more ? 'running' : 'completed', more ? 'partial' : 'complete', more ? 'Limite/paginação ainda não concluídos' : null);
      return this.store.summary(id) as unknown as JsonObject;
    } catch (error) { this.store.setStatus(id, 'partial', 'unknown', `${error instanceof Error ? error.name : 'Error'}: ${String(error)}`); throw error; }
  }
  async indexDocument(id: string, url: string): Promise<JsonObject> {
    const downloaded = await this.api.http.download(url);
    const saved = saveDocument(downloaded.data, join(this.dataDir, 'documents'));
    const documentId = saved.hash.slice(0, 16);
    try {
      const pages = await extractPdf(downloaded.data);
      this.store.addDocument(documentId, id, url, downloaded.finalUrl, saved.hash, downloaded.contentType, downloaded.data.length, 'indexed', saved.path, 'pdfjs-dist');
      this.store.addPages(documentId, pages);
      const evidenceIds = evidenceSnippets(pages).map((item) => this.store.addEvidence(id, item.text, url, item.page, documentId));
      return { documento_id: documentId, status: 'indexed', sha256: saved.hash, pages: pages.length, evidence_ids: evidenceIds, content_type: downloaded.contentType, final_url: downloaded.finalUrl };
    } catch (error) {
      this.store.addDocument(documentId, id, url, downloaded.finalUrl, saved.hash, downloaded.contentType, downloaded.data.length, 'extraction_failed', saved.path, null);
      return { documento_id: documentId, status: 'pending', sha256: saved.hash, reason: String(error) };
    }
  }
  evidence(id: string, topic?: string, limit = 20): JsonObject { return { pesquisa_id: id, evidencias: this.store.evidence(id, limit, topic), pendencias: [] }; }
  registerAnalysis(id: string, criteria: JsonObject, result: JsonObject, evidenceIds: string[]): JsonObject {
    const known = new Set(this.store.evidence(id, 10000).map((item) => item.id));
    const invalid = evidenceIds.filter((item) => !known.has(item)); if (invalid.length) throw new Error(`Evidências inexistentes: ${invalid.join(', ')}`);
    const analysisId = createHash('sha256').update(`${id}:${Date.now()}:${JSON.stringify(result)}`).digest('hex').slice(0, 12);
    this.store.db.prepare('INSERT INTO analises VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(analysisId, id, JSON.stringify(criteria), JSON.stringify(result), JSON.stringify(evidenceIds));
    return { analise_id: analysisId, pesquisa_id: id, evidencias: evidenceIds };
  }
  export(id: string, format: 'markdown' | 'json' = 'markdown'): JsonObject {
    const report = { pesquisa: this.store.summary(id, 100), evidencias: this.store.evidence(id, 100) }; const output = join(this.dataDir, 'exports'); mkdirSync(output, { recursive: true });
    const path = join(output, `${id}.${format === 'json' ? 'json' : 'md'}`);
    writeFileSync(path, format === 'json' ? JSON.stringify(report, null, 2) : `# Pesquisa PNCP ${id}\n\nStatus: ${report.pesquisa.status}\nCobertura: ${report.pesquisa.coverage}\nRegistros únicos: ${report.pesquisa.unique_records}\n`);
    return { path, summary: { unique_records: report.pesquisa.unique_records, coverage: report.pesquisa.coverage } };
  }
}
