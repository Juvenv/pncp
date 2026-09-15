import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { field, rows, stableId } from './parsers.js';
import type { JsonObject, SearchSummary } from './types.js';

const schema = `
CREATE TABLE IF NOT EXISTS pesquisas (id TEXT PRIMARY KEY, termos TEXT NOT NULL, filtros TEXT NOT NULL,
 status TEXT NOT NULL, next_page INTEGER NOT NULL DEFAULT 1, coverage TEXT NOT NULL DEFAULT 'unknown',
 reason TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS registros (pesquisa_id TEXT NOT NULL, origem_id TEXT NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY (pesquisa_id, origem_id));
CREATE TABLE IF NOT EXISTS paginas (pesquisa_id TEXT NOT NULL, pagina INTEGER NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY (pesquisa_id, pagina));
CREATE TABLE IF NOT EXISTS documentos (id TEXT PRIMARY KEY, pesquisa_id TEXT NOT NULL, url TEXT NOT NULL,
 final_url TEXT, sha256 TEXT NOT NULL, content_type TEXT, bytes INTEGER NOT NULL, status TEXT NOT NULL,
 path TEXT, extracted_with TEXT);
CREATE TABLE IF NOT EXISTS paginas_documento (documento_id TEXT NOT NULL, page INTEGER NOT NULL, text TEXT NOT NULL,
 PRIMARY KEY (documento_id, page));
CREATE TABLE IF NOT EXISTS evidencias (id TEXT PRIMARY KEY, pesquisa_id TEXT NOT NULL, documento_id TEXT,
 page INTEGER, trecho TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS analises (id TEXT PRIMARY KEY, pesquisa_id TEXT NOT NULL, criteria TEXT NOT NULL,
 result TEXT NOT NULL, evidence_ids TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`;

export class Store {
  readonly db: DatabaseSync;
  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.db.exec(schema);
  }
  close(): void { this.db.close(); }
  start(terms: string[] = [], filters: JsonObject = {}): string {
    const id = randomUUID().slice(0, 12);
    this.db.prepare("INSERT INTO pesquisas(id, termos, filtros, status) VALUES (?, ?, ?, 'queued')").run(id, JSON.stringify(terms), JSON.stringify(filters));
    return id;
  }
  ingest(id: string, page: number, payload: unknown): void {
    const parsed = rows(payload);
    const validated = parsed.map((item) => [stableId(item), JSON.stringify(item)] as const);
    const current = this.db.prepare('SELECT next_page FROM pesquisas WHERE id=?').get(id) as { next_page: number } | undefined;
    if (!current) throw new Error('Pesquisa inexistente');
    if (page > current.next_page) throw new Error('Página fora de ordem');
    this.db.exec('BEGIN');
    try {
      const record = this.db.prepare('INSERT OR REPLACE INTO registros VALUES (?, ?, ?)');
      for (const [originId, raw] of validated) record.run(id, originId, raw);
      this.db.prepare('INSERT OR REPLACE INTO paginas VALUES (?, ?, ?)').run(id, page, JSON.stringify(payload));
      this.db.prepare("UPDATE pesquisas SET next_page=MAX(next_page,?), status='running', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(page + 1, id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setStatus(id: string, status: string, coverage?: string, reason?: string | null): void {
    this.db.prepare('UPDATE pesquisas SET status=?, coverage=COALESCE(?, coverage), reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, coverage ?? null, reason ?? null, id);
  }
  summary(id: string, limit = 10): SearchSummary {
    const row = this.db.prepare('SELECT id, termos, filtros, status, next_page, coverage, reason FROM pesquisas WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Pesquisa inexistente');
    const result = this.db.prepare('SELECT payload FROM registros WHERE pesquisa_id=? ORDER BY origem_id LIMIT ?').all(id, limit) as Array<{ payload: string }>;
    const records = result.map((item) => JSON.parse(item.payload) as JsonObject);
    const title = (record: JsonObject): string | null => { const value = field(record, 'title', 'descricao', 'objeto'); return typeof value === 'string' ? value.trim() : null; };
    return { pesquisa_id: String(row.id), termos: JSON.parse(String(row.termos)) as string[], filtros: JSON.parse(String(row.filtros)) as JsonObject,
      status: String(row.status), next_page: Number(row.next_page), coverage: String(row.coverage), reason: row.reason == null ? null : String(row.reason),
      unique_records: Number((this.db.prepare('SELECT COUNT(*) AS count FROM registros WHERE pesquisa_id=?').get(id) as { count: number }).count),
      results: records.map((record) => ({ id: stableId(record), title: title(record), adesao: field(record, 'permite_adesao', 'possibilidadeAdesao') as boolean | null, orgao: field(record, 'orgao_nome', 'nomeOrgao') as string | null })) };
  }
  list(limit = 20): SearchSummary[] { return (this.db.prepare('SELECT id FROM pesquisas ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ id: string }>).map((row) => this.summary(row.id, 0)); }
  addDocument(id: string, researchId: string, url: string, finalUrl: string, hash: string, contentType: string, bytes: number, status: string, path: string, extractor: string | null): void {
    this.db.prepare('INSERT OR REPLACE INTO documentos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, researchId, url, finalUrl, hash, contentType, bytes, status, path, extractor);
  }
  addPages(id: string, pages: Array<{ page: number; text: string }>): void { const statement = this.db.prepare('INSERT OR REPLACE INTO paginas_documento VALUES (?, ?, ?)'); for (const page of pages) statement.run(id, page.page, page.text); }
  addEvidence(researchId: string, excerpt: string, source: string, page: number, documentId: string): string { const id = randomUUID().slice(0, 12); this.db.prepare('INSERT INTO evidencias VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(id, researchId, documentId, page, excerpt, source); return id; }
  evidence(researchId: string, limit = 20, topic?: string): Array<{ id: string; documento_id: string; page: number; trecho: string; source: string }> {
    const query = topic ? 'SELECT id, documento_id, page, trecho, source FROM evidencias WHERE pesquisa_id=? AND lower(trecho) LIKE ? ORDER BY id LIMIT ?' : 'SELECT id, documento_id, page, trecho, source FROM evidencias WHERE pesquisa_id=? ORDER BY id LIMIT ?';
    const args = topic ? [researchId, `%${topic.toLowerCase()}%`, limit] : [researchId, limit];
    return this.db.prepare(query).all(...args) as Array<{ id: string; documento_id: string; page: number; trecho: string; source: string }>;
  }
}
