import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { adhesion, field, rows, stableId, validateRecords } from './parsers.js';
import type { JsonObject, SearchSummary } from './types.js';
import { searchFilters, pendingFilters, type QueryProgress } from './search.js';
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
    if (path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.db.function('pncp_fold', { deterministic: true }, value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase());
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > 3) {
      this.db.close();
      throw new Error('Banco usa versão de esquema mais recente');
    }
    if (version < 3) {
      if (path !== ':memory:' && this.db.prepare("SELECT name FROM sqlite_master WHERE name='pesquisas'").get()) {
        const directory = join(dirname(path), 'backups');
        mkdirSync(directory, { recursive: true });
        this.db.prepare('VACUUM INTO ?').run(join(directory, `pncp-before-v3-${Date.now()}-${randomUUID().slice(0, 8)}.sqlite3`));
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(schema);
        const columns = (table: string): string[] => (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>).map(row => row.name);
        if (!columns('pesquisas').includes('revision'))
          this.db.exec('ALTER TABLE pesquisas ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
        if (!columns('pesquisas').includes('tamanho_pagina'))
          this.db.exec('ALTER TABLE pesquisas ADD COLUMN tamanho_pagina INTEGER');
        if (!columns('documentos').includes('reason'))
          this.db.exec('ALTER TABLE documentos ADD COLUMN reason TEXT');
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS consultas_estado (pesquisa_id TEXT NOT NULL REFERENCES pesquisas(id), termo TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(pesquisa_id,termo));
          CREATE TABLE IF NOT EXISTS consultas_registros (pesquisa_id TEXT NOT NULL REFERENCES pesquisas(id), termo TEXT NOT NULL, origem_id TEXT NOT NULL, PRIMARY KEY(pesquisa_id,termo,origem_id));
          CREATE TABLE IF NOT EXISTS consultas_paginas (pesquisa_id TEXT NOT NULL REFERENCES pesquisas(id), termo TEXT NOT NULL, pagina INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(pesquisa_id,termo,pagina));
          CREATE TABLE IF NOT EXISTS coleta_locks (pesquisa_id TEXT PRIMARY KEY REFERENCES pesquisas(id), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS documento_vinculos (pesquisa_id TEXT NOT NULL REFERENCES pesquisas(id), documento_id TEXT NOT NULL REFERENCES documentos(id), url TEXT NOT NULL, PRIMARY KEY(pesquisa_id,documento_id,url));
          INSERT OR IGNORE INTO documento_vinculos SELECT pesquisa_id,id,url FROM documentos;
          CREATE UNIQUE INDEX IF NOT EXISTS documentos_hash ON documentos(sha256);
          CREATE INDEX IF NOT EXISTS evidencias_pesquisa ON evidencias(pesquisa_id,id);
          CREATE INDEX IF NOT EXISTS analises_pesquisa ON analises(pesquisa_id,id);
          CREATE TRIGGER IF NOT EXISTS documentos_parent BEFORE INSERT ON documentos BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pesquisas WHERE id=NEW.pesquisa_id) THEN RAISE(ABORT,'Pesquisa inexistente') END; END;
          CREATE TRIGGER IF NOT EXISTS documentos_owner BEFORE UPDATE OF pesquisa_id ON documentos WHEN NEW.pesquisa_id<>OLD.pesquisa_id BEGIN SELECT RAISE(ABORT,'Documento deve ser associado por vínculo'); END;
          CREATE TRIGGER IF NOT EXISTS evidencias_parent BEFORE INSERT ON evidencias BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM documento_vinculos WHERE pesquisa_id=NEW.pesquisa_id AND documento_id=NEW.documento_id) THEN RAISE(ABORT,'Vínculo documental inexistente') END; END;
          CREATE TRIGGER IF NOT EXISTS analises_parent BEFORE INSERT ON analises BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pesquisas WHERE id=NEW.pesquisa_id) THEN RAISE(ABORT,'Pesquisa inexistente') END; END;
          CREATE TRIGGER IF NOT EXISTS paginas_documento_parent BEFORE INSERT ON paginas_documento BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM documentos WHERE id=NEW.documento_id) THEN RAISE(ABORT,'Documento inexistente') END; END;
          CREATE TRIGGER IF NOT EXISTS registros_parent BEFORE INSERT ON registros BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pesquisas WHERE id=NEW.pesquisa_id) THEN RAISE(ABORT,'Pesquisa inexistente') END; END;
          CREATE TRIGGER IF NOT EXISTS paginas_parent BEFORE INSERT ON paginas BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pesquisas WHERE id=NEW.pesquisa_id) THEN RAISE(ABORT,'Pesquisa inexistente') END; END;
          UPDATE documentos SET status='needs_ocr',reason='Extração histórica sem texto legível; OCR/validação manual pendente'
            WHERE status='indexed' AND EXISTS(SELECT 1 FROM paginas_documento p WHERE p.documento_id=documentos.id)
            AND NOT EXISTS(SELECT 1 FROM paginas_documento p WHERE p.documento_id=documentos.id AND length(trim(p.text))>0);
          PRAGMA user_version=3;
        `);
        this.db.exec('COMMIT');
      }
      catch (error) {
        this.db.exec('ROLLBACK');
        this.db.close();
        throw error;
      }
    }
  }
  close(): void { this.db.close(); }
  start(terms: string[] = [], filters: JsonObject = {}): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO pesquisas(id, termos, filtros, status) VALUES (?, ?, ?, 'queued')").run(id, JSON.stringify(terms), JSON.stringify(filters));
    return id;
  }
  ingest(id: string, page: number, payload: unknown): void {
    const parsed = rows(payload);
    validateRecords(parsed);
    const validated = parsed.map((item) => [stableId(item), JSON.stringify(item)] as const);
    const current = this.db.prepare('SELECT next_page FROM pesquisas WHERE id=?').get(id) as {
      next_page: number;
    } | undefined;
    if (!current)
      throw new Error('Pesquisa inexistente');
    if (page > current.next_page)
      throw new Error('Página fora de ordem');
    this.db.exec('BEGIN');
    try {
      const record = this.db.prepare('INSERT OR REPLACE INTO registros VALUES (?, ?, ?)');
      for (const [originId, raw] of validated)
        record.run(id, originId, raw);
      this.db.prepare('INSERT OR REPLACE INTO paginas VALUES (?, ?, ?)').run(id, page, JSON.stringify(payload));
      this.db.prepare("UPDATE pesquisas SET next_page=MAX(next_page,?), status='running', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(page + 1, id);
      this.db.exec('COMMIT');
    }
    catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  setStatus(id: string, status: string, coverage?: string, reason?: string | null): void {
    this.db.prepare('UPDATE pesquisas SET status=?, coverage=COALESCE(?, coverage), reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, coverage ?? null, reason ?? null, id);
  }
  lastPage(id: string): JsonObject | null {
    const row = this.db.prepare('SELECT payload FROM paginas WHERE pesquisa_id=? ORDER BY pagina DESC LIMIT 1').get(id) as {
      payload: string;
    } | undefined;
    return row ? JSON.parse(row.payload) as JsonObject : null;
  }
  summary(id: string, limit = 10, cursor?: string, offset = 0): SearchSummary {
    const row = this.db.prepare('SELECT id, termos, filtros, status, next_page, coverage, reason FROM pesquisas WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!row)
      throw new Error('Pesquisa inexistente');
    const result = this.db.prepare('SELECT payload FROM registros WHERE pesquisa_id=? AND origem_id>? ORDER BY origem_id LIMIT ? OFFSET ?').all(id, cursor ?? '', limit + 1, offset) as Array<{
      payload: string;
    }>;
    const hasMore = result.length > limit;
    result.splice(limit);
    const records = result.map((item) => JSON.parse(item.payload) as JsonObject);
    const filters = JSON.parse(String(row.filtros)) as JsonObject;
    const legacy = ![2, 3].includes(Number(filters._search_version));
    const historical = filters._search_version === 2 && !this.db.prepare('SELECT 1 FROM consultas_estado WHERE pesquisa_id=?').get(id);
    const pending = pendingFilters(filters);
    const totalRecords = Number((this.db.prepare('SELECT COUNT(*) AS count FROM registros WHERE pesquisa_id=?').get(id) as {
      count: number;
    }).count);
    const title = (record: JsonObject): string | null => { const value = field(record, 'title', 'descricao', 'objeto'); return typeof value === 'string' ? value.trim() : null; };
    return {
      pesquisa_id: String(row.id), termos: JSON.parse(String(row.termos)) as string[], filtros: JSON.parse(String(row.filtros)) as JsonObject,
      status: String(row.status), next_page: Number(row.next_page), coverage: legacy || historical ? 'unknown' : String(row.coverage), reason: row.reason == null ? null : String(row.reason),
      unique_records: totalRecords,
      filtros_efetivos: legacy ? null : searchFilters(filters),
      filtros_nao_aplicados: pending,
      consultas: this.progress(id),
      results_returned: records.length, results_truncated: records.length < totalRecords,
      next_cursor: hasMore && records.length ? stableId(records.at(-1)!) : null,
      escopo_cobertura: 'Paginação das consultas textuais no índice PNCP; não confirma capacidade, preço ou autorização de adesão.',
      pendencias: [...(legacy ? ['Pesquisa legada: filtros e sinônimos não eram aplicados corretamente; refaça a pesquisa.'] : []), ...(historical ? ['Cobertura histórica v2 não revalidada; pesquisas concluídas devem ser refeitas para comprovar cobertura com a correção.'] : []), ...pending.map(key => `Filtro não aplicado: ${key}`), 'Validar capacidade e vigência nos documentos.', 'Confirmar separadamente preço estimado, homologado, registrado e alterações posteriores.', 'Cadastro de adesão não constitui autorização de adesão.'],
      results: records.map((record) => ({
        id: stableId(record), title: title(record), adesao: adhesion(record), orgao: field(record, 'orgao_nome', 'nomeOrgao') as string | null,
        descricao: field(record, 'description', 'descricao', 'objeto'), url: typeof record.item_url === 'string' && record.item_url.startsWith('/atas/') ? `https://pncp.gov.br/app${record.item_url}` : null,
        esfera: field(record, 'esfera_id'), inicio_vigencia: field(record, 'data_inicio_vigencia'), fim_vigencia: field(record, 'data_fim_vigencia')
      }))
    };
  }
  list(limit = 20): SearchSummary[] {
    return (this.db.prepare('SELECT id FROM pesquisas ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{
      id: string;
    }>).map((row) => this.summary(row.id, 0));
  }
  addDocument(id: string, researchId: string, url: string, finalUrl: string, hash: string, contentType: string, bytes: number, status: string, path: string, extractor: string | null, reason: string | null = null): void {
    this.requireResearch(researchId);
    this.db.prepare('INSERT INTO documentos(id,pesquisa_id,url,final_url,sha256,content_type,bytes,status,path,extracted_with,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,reason=excluded.reason,extracted_with=excluded.extracted_with,path=excluded.path').run(id, researchId, url, finalUrl, hash, contentType, bytes, status, path, extractor, reason);
    this.linkDocument(researchId, id, url);
  }
  addPages(id: string, pages: Array<{
    page: number;
    text: string;
  }>): void {
    const statement = this.db.prepare('INSERT OR REPLACE INTO paginas_documento VALUES (?, ?, ?)'); for (const page of pages)
      statement.run(id, page.page, page.text);
  }
  addEvidence(researchId: string, excerpt: string, source: string, page: number, documentId: string): string {
    const id = createHash('sha256').update(JSON.stringify([researchId, documentId, page, excerpt])).digest('hex');
    this.db.prepare('INSERT OR IGNORE INTO evidencias VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(id, researchId, documentId, page, excerpt, source);
    return id;
  }
  evidence(researchId: string, limit = 20, topic?: string, cursor?: string): Array<{
    id: string;
    documento_id: string;
    page: number;
    trecho: string;
    source: string;
  }> {
    this.requireResearch(researchId);
    const query = 'SELECT id,documento_id,page,trecho,source FROM evidencias WHERE pesquisa_id=? AND id>?' + (topic ? ' AND instr(pncp_fold(trecho),pncp_fold(?))>0' : '') + ' ORDER BY id LIMIT ?';
    const args = topic ? [researchId, cursor ?? '', topic, limit] : [researchId, cursor ?? '', limit];
    return this.db.prepare(query).all(...args) as Array<{
      id: string;
      documento_id: string;
      page: number;
      trecho: string;
      source: string;
    }>;
  }
  requireResearch(id: string): {
    filtros: string;
    status: string;
    revision: number;
    tamanho_pagina: number | null;
  } {
    const value = this.db.prepare('SELECT filtros,status,revision,tamanho_pagina FROM pesquisas WHERE id=?').get(id);
    if (!value)
      throw new Error('Pesquisa inexistente');
    return value as unknown as {
      filtros: string;
      status: string;
      revision: number;
      tamanho_pagina: number | null;
    };
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    }
    catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  progress(id: string): QueryProgress[] {
    const saved = this.db.prepare('SELECT state FROM consultas_estado WHERE pesquisa_id=? ORDER BY termo').all(id) as Array<{
      state: string;
    }>;
    if (saved.length)
      return saved.map(row => JSON.parse(row.state) as QueryProgress);
    this.requireResearch(id);
    const terms = JSON.parse(String((this.db.prepare('SELECT termos FROM pesquisas WHERE id=?').get(id))?.termos)) as string[];
    const old = (this.lastPage(id)?.consultas ?? []) as QueryProgress[];
    return (terms.length ? terms : ['']).map(termo => old.find(q => q.termo === termo) ?? { termo, pagina: 0, recebidos: 0, total: null, completa: false, url: '' });
  }
  acquire(id: string, size: number): {
    owner: string;
    revision: number;
  } {
    return this.transaction(() => {
      const research = this.requireResearch(id);
      if (['paused', 'cancelled'].includes(research.status))
        throw new Error('Pesquisa pausada ou cancelada');
      if (research.tamanho_pagina !== null && research.tamanho_pagina !== size)
        throw new Error('Mantenha o tamanho de página');
      const lock = this.db.prepare('SELECT expires_at FROM coleta_locks WHERE pesquisa_id=?').get(id);
      if (lock && Number(lock.expires_at) > Date.now())
        throw new Error('Pesquisa já possui uma coleta em andamento');
      const owner = randomUUID();
      this.db.prepare('INSERT INTO coleta_locks VALUES(?,?,?) ON CONFLICT(pesquisa_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at').run(id, owner, Date.now() + 60000);
      this.db.prepare("UPDATE pesquisas SET tamanho_pagina=?,status=CASE WHEN status='completed' THEN status ELSE 'running' END,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(size, id);
      if (!this.db.prepare('SELECT 1 FROM consultas_estado WHERE pesquisa_id=?').get(id)) {
        for (const query of this.progress(id))
          this.saveProgress(id, query);
        const pages = this.db.prepare('SELECT payload FROM paginas WHERE pesquisa_id=? ORDER BY pagina').all(id) as Array<{
          payload: string;
        }>;
        for (const page of pages) {
          const payload = JSON.parse(page.payload) as JsonObject;
          for (const response of (payload.respostas ?? []) as Array<{
            termo: string;
            payload: unknown;
          }>) {
            for (const record of rows(response.payload))
              this.db.prepare('INSERT OR IGNORE INTO consultas_registros VALUES(?,?,?)').run(id, response.termo, stableId(record));
          }
        }
      }
      for (const query of this.progress(id)) {
        const known = Number(this.db.prepare('SELECT count(*) n FROM consultas_registros WHERE pesquisa_id=? AND termo=?').get(id, query.termo)?.n ?? 0);
        if (known !== query.recebidos)
          throw new Error('Histórico do termo tem contagem inconsistente; refaça a pesquisa para comprovar cobertura');
      }
      return { owner, revision: research.revision };
    });
  }
  release(id: string, owner: string): void { this.db.prepare('DELETE FROM coleta_locks WHERE pesquisa_id=? AND owner=?').run(id, owner); }
  finish(id: string, lease: {
    owner: string;
    revision: number;
  }): void { this.transaction(() => { this.assertLease(id, lease); this.refresh(id); }); }
  assertLease(id: string, lease: {
    owner: string;
    revision: number;
  }): void {
    const research = this.requireResearch(id);
    const lock = this.db.prepare('SELECT owner,expires_at FROM coleta_locks WHERE pesquisa_id=?').get(id);
    if (!lock || lock.owner !== lease.owner || Number(lock.expires_at) <= Date.now() || research.revision !== lease.revision || ['paused', 'cancelled'].includes(research.status))
      throw new Error('Coleta interrompida ou lease expirado; resultado não gravado');
  }
  private saveProgress(id: string, query: QueryProgress): void {
    this.db.prepare('INSERT INTO consultas_estado VALUES(?,?,?) ON CONFLICT(pesquisa_id,termo) DO UPDATE SET state=excluded.state').run(id, query.termo, JSON.stringify(query));
  }
  private refresh(id: string): void {
    const progress = this.progress(id);
    const filters = JSON.parse(this.requireResearch(id).filtros) as JsonObject;
    const max = Number((filters.limites as JsonObject | undefined)?.max_paginas ?? 5);
    const pending = progress.filter(q => !q.completa);
    const errors = pending.filter(q => q.erro);
    const limited = pending.some(q => q.pagina >= max);
    const count = Number(this.db.prepare('SELECT count(*) n FROM registros WHERE pesquisa_id=?').get(id)?.n ?? 0);
    const status = !pending.length ? 'completed' : errors.length || limited ? 'partial' : 'running';
    const coverage = !pending.length ? 'complete' : count ? 'partial' : 'unknown';
    const reason = errors.length ? JSON.stringify(errors.map(q => ({ termo: q.termo, erro: q.erro }))) : limited ? 'Limite de páginas atingido; amplie limites.max_paginas ao retomar' : pending.length ? 'Paginação ainda não concluída' : null;
    const next = pending.length ? Math.min(...pending.map(q => q.pagina + 1)) : Math.max(0, ...progress.map(q => q.pagina)) + 1;
    this.db.prepare('UPDATE pesquisas SET status=?,coverage=?,reason=?,next_page=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, coverage, reason, next, id);
  }
  commitQuery(id: string, lease: {
    owner: string;
    revision: number;
  }, query: QueryProgress, payload: unknown, records: JsonObject[], assertActive: () => void): void {
    this.transaction(() => {
      assertActive();
      this.assertLease(id, lease);
      validateRecords(records);
      const previous = this.progress(id).find(q => q.termo === query.termo)!;
      if (query.pagina !== previous.pagina + 1)
        throw new Error('Página já coletada ou fora de ordem');
      for (const record of records) {
        const key = stableId(record);
        if (this.db.prepare('SELECT 1 FROM consultas_registros WHERE pesquisa_id=? AND termo=? AND origem_id=?').get(id, query.termo, key))
          throw new Error('Página repetida ou índice alterado: identificador já recebido para este termo; refaça a pesquisa');
        this.db.prepare('INSERT INTO consultas_registros VALUES(?,?,?)').run(id, query.termo, key);
        this.db.prepare('INSERT INTO registros VALUES(?,?,?) ON CONFLICT(pesquisa_id,origem_id) DO UPDATE SET payload=excluded.payload').run(id, key, JSON.stringify(record));
      }
      this.db.prepare('INSERT INTO consultas_paginas VALUES(?,?,?,?)').run(id, query.termo, query.pagina, JSON.stringify(payload));
      this.saveProgress(id, query);
      this.refresh(id);
    });
  }
  failQuery(id: string, lease: {
    owner: string;
    revision: number;
  }, term: string, error: unknown): void {
    this.transaction(() => { this.assertLease(id, lease); const previous = this.progress(id).find(q => q.termo === term)!; this.saveProgress(id, { ...previous, erro: error }); this.refresh(id); });
  }
  control(id: string, status: string, maxPages?: number): void {
    this.transaction(() => {
      const current = this.requireResearch(id);
      const filters = JSON.parse(current.filtros) as JsonObject;
      if (maxPages !== undefined) {
        const limits = (filters.limites ?? {}) as JsonObject;
        if (maxPages < Number(limits.max_paginas ?? 5))
          throw new Error('A retomada só pode aumentar max_paginas');
        filters.limites = { ...limits, max_paginas: maxPages };
      }
      this.db.prepare('UPDATE pesquisas SET status=?,filtros=?,reason=NULL,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(current.status === 'completed' && status === 'running' ? 'completed' : status, JSON.stringify(filters), id);
    });
  }
  linkDocument(research: string, document: string, url: string): void { this.db.prepare('INSERT OR IGNORE INTO documento_vinculos VALUES(?,?,?)').run(research, document, url); }
  documentByHash(hash: string): JsonObject | undefined { return this.db.prepare('SELECT * FROM documentos WHERE sha256=?').get(hash) as JsonObject | undefined; }
  documentByUrl(url: string): JsonObject | undefined { return this.db.prepare('SELECT d.* FROM documentos d JOIN documento_vinculos v ON v.documento_id=d.id WHERE v.url=? LIMIT 1').get(url) as JsonObject | undefined; }
  documents(id: string, limit = 20, cursor = ''): JsonObject[] {
    this.requireResearch(id);
    return this.db.prepare('SELECT d.*,MIN(v.url) AS source_url FROM documentos d JOIN documento_vinculos v ON v.documento_id=d.id WHERE v.pesquisa_id=? AND d.id>? GROUP BY d.id ORDER BY d.id LIMIT ?').all(id, cursor, limit) as JsonObject[];
  }
  analyses(id: string, limit = 20, cursor = ''): JsonObject[] {
    this.requireResearch(id);
    return (this.db.prepare('SELECT * FROM analises WHERE pesquisa_id=? AND id>? ORDER BY id LIMIT ?').all(id, cursor, limit) as JsonObject[]).map(a => ({ ...a, criteria: JSON.parse(String(a.criteria)), result: JSON.parse(String(a.result)), evidence_ids: JSON.parse(String(a.evidence_ids)) }));
  }
}
