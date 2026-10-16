import { mkdirSync, readFileSync, existsSync, openSync, writeSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PncpApi } from './api.js';
import { evidenceSnippets, extractPdf, saveDocument } from './documents.js';
import { rows, validateRecords } from './parsers.js';
import { Store } from './store.js';
import { abortable, errorDetails, remoteUrl } from './http.js';
import type { JsonObject } from './types.js';
import { searchFilters, queryProgress, type QueryProgress } from './search.js';
const active = new Map<string, Set<AbortController>>();
function limitsInput(input: JsonObject): JsonObject {
  const allowed = new Set(['tamanho_pagina', 'max_paginas', 'max_requisicoes']);
  for (const key of Object.keys(input))
    if (!allowed.has(key))
      throw new Error(`Limite não implementado: ${key}`);
  const values = { tamanho_pagina: 100, max_paginas: 5, max_requisicoes: 30, ...input };
  for (const [key, value] of Object.entries(values)) {
    const max = key === 'max_paginas' ? 1000 : 100;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (key === 'tamanho_pagina' ? 10 : 1) || value > max)
      throw new Error(`Limite inválido: ${key}`);
  }
  return values;
}
export class Service {
  readonly store: Store;
  constructor(readonly dataDir = process.env.PNCP_DATA_DIR ?? join(process.cwd(), 'dados'), readonly api = new PncpApi()) {
    mkdirSync(dataDir, { recursive: true });
    this.store = new Store(join(dataDir, 'pncp.sqlite3'));
  }
  close(): void { this.store.close(); }
  private key(id: string): string { return `${resolve(this.store.path)}:${id}`; }
  private operation(id: string, parent?: AbortSignal, timeout = 45000) {
    const controller = new AbortController();
    const key = this.key(id);
    const set = active.get(key) ?? new Set<AbortController>();
    set.add(controller);
    active.set(key, set);
    const timer = setTimeout(() => controller.abort(new DOMException('Orçamento de tempo da operação esgotado', 'TimeoutError')), timeout);
    const signal = parent ? AbortSignal.any([controller.signal, parent]) : controller.signal;
    const revision = this.store.requireResearch(id).revision;
    const poll = setInterval(() => {
      try {
        if (this.store.requireResearch(id).revision !== revision)
          controller.abort(new Error('Pesquisa controlada em outra chamada'));
      }
      catch (error) {
        controller.abort(error);
      }
    }, 100);
    return {
      signal, assertActive: () => {
        signal.throwIfAborted(); if (this.store.requireResearch(id).revision !== revision)
          throw new Error('Estado da pesquisa mudou; resultado não gravado');
      }, dispose: () => {
        clearTimeout(timer); clearInterval(poll); set.delete(controller); if (!set.size)
          active.delete(key);
      }
    };
  }
  start(terms: string[] = [], filters: JsonObject = {}, mode = 'busca_rapida', limits: JsonObject = {}, allowBroad = false): JsonObject {
    searchFilters(filters);
    if ('limites' in filters)
      throw new Error('Envie limites como argumento separado, fora de filtros');
    if (mode !== 'busca_rapida')
      throw new Error('Somente modo=busca_rapida está implementado');
    const normalized = [...new Set(terms.map(term => term.trim()).filter(Boolean))];
    if (!normalized.length && (!allowBroad || limits.max_paginas === undefined))
      throw new Error('Busca vazia exige permitir_busca_ampla=true e max_paginas explícito');
    const effectiveLimits = limitsInput(limits);
    const id = this.store.start(normalized, { ...filters, modo: mode, limites: effectiveLimits, _search_version: 3 });
    return { ...this.store.summary(id), interpretação: { termos_pesquisados: normalized, estrategia: 'Consultas independentes; checkpoint por termo e página; união por identificador PNCP.', filtros_tecnicos_locais: false, cobertura_inicial: 'nenhuma página coletada' } };
  }
  async collect(id: string, pageSize?: number, parent?: AbortSignal): Promise<JsonObject> {
    const current = this.store.summary(id, 0), filters = current.filtros;
    if (![2, 3].includes(Number(filters._search_version)))
      throw new Error('Pesquisa legada: crie uma nova pesquisa');
    if (current.status === 'completed')
      return this.store.summary(id) as unknown as JsonObject;
    const limits = limitsInput((filters.limites ?? {}) as JsonObject);
    const previous = this.store.lastPage(id);
    const size = pageSize ?? this.store.requireResearch(id).tamanho_pagina ?? previous?.tamanho_pagina ?? limits.tamanho_pagina;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 10 || size > 100)
      throw new Error('Tamanho de página deve estar entre 10 e 100');
    if (previous && previous.tamanho_pagina !== size)
      throw new Error('Mantenha o tamanho de página');
    const lease = this.store.acquire(id, size);
    const op = this.operation(id, parent);
    let firstError: unknown;
    const budget = { remaining: Number(limits.max_requisicoes) };
    try {
      if (this.store.requireResearch(id).status === 'completed')
        return this.store.summary(id) as unknown as JsonObject;
      for (const term of current.termos.length ? current.termos : ['']) {
        const old = this.store.progress(id).find(q => q.termo === term)!;
        if (old.completa || old.pagina >= Number(limits.max_paginas))
          continue;
        try {
          op.assertActive();
          const known = Number(this.store.db.prepare('SELECT count(*) n FROM consultas_registros WHERE pesquisa_id=? AND termo=?').get(id, term)?.n ?? 0);
          if (known !== old.recebidos)
            throw new Error('Histórico do termo tem contagem inconsistente; refaça a pesquisa para comprovar cobertura');
          const effective = searchFilters(filters), page = old.pagina + 1;
          const payload = await abortable(this.api.search(term, page, size, effective, { signal: op.signal, budget }), op.signal);
          op.assertActive();
          const records = rows(payload);
          validateRecords(records);
          if (records.length > size)
            throw new Error('PNCP retornou mais registros que o tamanho de página solicitado');
          const progress = queryProgress(payload, records.length, size, old.recebidos);
          if (old.total !== null && progress.total !== old.total)
            throw new Error('Total mudou durante a paginação; refaça a pesquisa para evitar cobertura incorreta');
          const url = new URL(PncpApi.searchUrl);
          for (const [key, value] of Object.entries({ ...effective, q: term || undefined, pagina: page, tam_pagina: size }))
            if (value !== undefined)
              url.searchParams.set(key, String(value));
          const state: QueryProgress = { termo: term, pagina: page, ...progress, url: url.href };
          this.store.commitQuery(id, lease, state, payload, records, op.assertActive);
        }
        catch (error) {
          firstError ??= error;
          const state = this.store.requireResearch(id);
          if (state.revision === lease.revision && !['paused', 'cancelled'].includes(state.status))
            this.store.failQuery(id, lease, term, errorDetails(error));
          if (op.signal.aborted || budget.remaining <= 0)
            break;
        }
      }
      this.store.finish(id, lease);
      if (firstError)
        throw firstError;
      return this.store.summary(id) as unknown as JsonObject;
    }
    finally {
      op.dispose();
      this.store.release(id, lease.owner);
    }
  }
  control(id: string, action: 'pausar' | 'retomar' | 'cancelar', limits: JsonObject = {}, expand = false): JsonObject {
    this.store.requireResearch(id);
    if (Object.keys(limits).some(k => k !== 'max_paginas'))
      throw new Error('Na retomada só é permitido aumentar max_paginas');
    if (expand && limits.max_paginas === undefined)
      throw new Error('ampliar_escopo exige limites.max_paginas explícito');
    const max = limits.max_paginas;
    if (max !== undefined && (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1 || max > 1000))
      throw new Error('max_paginas inválido');
    this.store.control(id, { pausar: 'paused', retomar: 'running', cancelar: 'cancelled' }[action], max as number | undefined);
    for (const controller of active.get(this.key(id)) ?? [])
      controller.abort(new Error(`Pesquisa: ${action}`));
    return this.store.summary(id) as unknown as JsonObject;
  }
  private attachCached(id: string, document: JsonObject, url: string, assertActive: () => void): JsonObject {
    const documentId = String(document.id);
    this.store.transaction(() => {
      assertActive();
      this.store.linkDocument(id, documentId, url);
      const pages = this.store.db.prepare('SELECT page,text FROM paginas_documento WHERE documento_id=? ORDER BY page').all(documentId) as Array<{
        page: number;
        text: string;
      }>;
      if (document.status === 'indexed' && pages.length && !pages.some(page => page.text.trim())) {
        document.status = 'needs_ocr';
        document.reason = 'PDF sem texto legível; OCR/validação manual pendente';
        this.store.db.prepare('UPDATE documentos SET status=?,reason=? WHERE id=?').run(String(document.status), String(document.reason), documentId);
      }
      for (const snippet of evidenceSnippets(pages))
        this.store.addEvidence(id, snippet.text, url, snippet.page, documentId);
    });
    return { documento_id: documentId, status: document.status === 'indexed' ? 'indexed' : 'pending', sha256: document.sha256, reason: document.reason ?? null, cache: true };
  }
  async indexDocument(id: string, url: string, parent?: AbortSignal, refresh = false): Promise<JsonObject> {
    this.store.requireResearch(id);
    remoteUrl(url);
    const op = this.operation(id, parent, 40000);
    try {
      const cached = this.store.documentByUrl(url);
      if (cached && !refresh && existsSync(String(cached.path)) && createHash('sha256').update(readFileSync(String(cached.path))).digest('hex') === cached.sha256)
        return this.attachCached(id, cached, url, op.assertActive);
      const downloaded = await abortable(this.api.http.download(url, 'documento', { signal: op.signal, budget: { remaining: 3 } }), op.signal);
      op.assertActive();
      const hash = createHash('sha256').update(downloaded.data).digest('hex');
      const same = this.store.documentByHash(hash);
      if (same && !refresh && existsSync(String(same.path)) && createHash('sha256').update(readFileSync(String(same.path))).digest('hex') === hash)
        return this.attachCached(id, same, url, op.assertActive);
      let pages: Array<{
        page: number;
        text: string;
      }> = [], status = 'indexed', reason: string | null = null;
      try {
        pages = await extractPdf(downloaded.data, op.signal);
        if (!pages.some(page => page.text.trim())) {
          status = 'needs_ocr';
          reason = 'PDF sem texto legível; OCR/validação manual pendente';
        }
      }
      catch (error) {
        if (op.signal.aborted)
          throw error;
        status = downloaded.data.subarray(0, 5).toString('ascii') === '%PDF-' ? 'extraction_failed' : 'unsupported';
        reason = JSON.stringify(errorDetails(error));
      }
      op.assertActive();
      const saved = saveDocument(downloaded.data, join(this.dataDir, 'documents'));
      const documentId = same ? String(same.id) : saved.hash;
      const snippets = evidenceSnippets(pages);
      const evidenceIds = this.store.transaction(() => {
        op.assertActive();
        this.store.addDocument(documentId, id, url, downloaded.finalUrl, saved.hash, downloaded.contentType, downloaded.data.length, status, saved.path, status === 'indexed' || status === 'needs_ocr' ? 'pdfjs-dist' : null, reason);
        this.store.addPages(documentId, pages);
        return snippets.map(item => this.store.addEvidence(id, item.text, url, item.page, documentId));
      });
      return { documento_id: documentId, status: status === 'indexed' ? 'indexed' : 'pending', document_status: status, sha256: saved.hash, pages: pages.length, evidence_ids: evidenceIds, reason, cache: false };
    }
    finally {
      op.dispose();
    }
  }
  evidence(id: string, topic?: string, limit = 20, cursor?: string): JsonObject {
    this.store.requireResearch(id);
    if (topic?.trim())
      this.store.transaction(() => {
        const pages = this.store.db.prepare('SELECT DISTINCT p.documento_id,p.page,p.text,MIN(v.url) source FROM paginas_documento p JOIN documento_vinculos v ON v.documento_id=p.documento_id WHERE v.pesquisa_id=? AND instr(pncp_fold(p.text),pncp_fold(?))>0 GROUP BY p.documento_id,p.page ORDER BY p.documento_id,p.page').iterate(id, topic);
        for (const row of pages)
          for (const snippet of evidenceSnippets([{ page: Number(row.page), text: String(row.text) }], [topic]))
            this.store.addEvidence(id, snippet.text, String(row.source), snippet.page, String(row.documento_id));
      });
    const found = this.store.evidence(id, limit + 1, topic, cursor), more = found.length > limit;
    found.splice(limit);
    const pending = this.store.db.prepare("SELECT DISTINCT d.id,d.status,d.reason FROM documentos d JOIN documento_vinculos v ON v.documento_id=d.id WHERE v.pesquisa_id=? AND d.status<>'indexed'").all(id);
    return { pesquisa_id: id, evidencias: found, next_cursor: more ? found.at(-1)?.id ?? null : null, results_truncated: more, pendencias: [...this.store.summary(id, 0).pendencias, ...pending.map(d => `Documento ${d.id}: ${d.reason ?? d.status}`), ...(!found.length ? ['Nenhuma evidência nesta página; não implica ausência de requisitos/documentos.'] : [])] };
  }
  documentPage(id: string, documentId: string, page: number, start = 0): JsonObject {
    this.store.requireResearch(id);
    if (!this.store.db.prepare('SELECT 1 FROM documento_vinculos WHERE pesquisa_id=? AND documento_id=?').get(id, documentId))
      throw new Error('Documento não pertence à pesquisa');
    const row = this.store.db.prepare('SELECT text FROM paginas_documento WHERE documento_id=? AND page=?').get(documentId, page);
    if (!row)
      throw new Error('Página inexistente ou documento ainda não extraído');
    const text = String(row.text);
    return { documento_id: documentId, page, text: text.slice(start, start + 20000), next_offset: start + 20000 < text.length ? start + 20000 : null, conteudo_nao_confiavel: true };
  }
  registerAnalysis(id: string, criteria: JsonObject, result: JsonObject, evidenceIds: string[]): JsonObject {
    this.store.requireResearch(id);
    if (!evidenceIds.length)
      throw new Error('Análise exige ao menos uma evidência da pesquisa');
    for (const key of new Set(evidenceIds))
      if (!this.store.db.prepare('SELECT 1 FROM evidencias WHERE pesquisa_id=? AND id=?').get(id, key))
        throw new Error(`Evidência inexistente na pesquisa: ${key}`);
    const analysisId = randomUUID();
    this.store.db.prepare('INSERT INTO analises VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)').run(analysisId, id, JSON.stringify(criteria), JSON.stringify(result), JSON.stringify([...new Set(evidenceIds)]));
    return { analise_id: analysisId, pesquisa_id: id, evidencias: evidenceIds };
  }
  export(id: string, format: 'markdown' | 'json' = 'markdown'): JsonObject {
    let summary = this.store.summary(id, 0);
    const directory = join(this.dataDir, 'exports');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${id}.${format === 'json' ? 'json' : 'md'}`), temporary = join(directory, `${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx');
    const write = (text: string) => { writeSync(fd, text); };
    let closed = false;
    this.store.db.exec('BEGIN');
    try {
      summary = this.store.summary(id, 0);
      const { results: _results, ...metadata } = summary;
      if (format === 'json')
        write(`{"pesquisa":${JSON.stringify({ ...metadata, results_returned: summary.unique_records, results_truncated: false, next_cursor: null }).slice(0, -1)},"results":[`);
      else
        write(`# Pesquisa PNCP ${id}\n\nStatus: ${summary.status}\nCobertura: ${summary.coverage}\nTermos: ${JSON.stringify(summary.termos)}\nFiltros efetivos: ${JSON.stringify(summary.filtros_efetivos)}\nFiltros não aplicados: ${JSON.stringify(summary.filtros_nao_aplicados)}\nConsultas: ${JSON.stringify(summary.consultas)}\nMotivo: ${summary.reason ?? 'nenhum'}\n\nPendências:\n${summary.pendencias.map(p => `- ${p}`).join('\n')}\n\n## Registros\n`);
      let cursor: string | undefined, first = true;
      do {
        const batch = this.store.summary(id, 500, cursor);
        for (const record of batch.results) {
          write(format === 'json' ? `${first ? '' : ','}${JSON.stringify(record)}` : `- ${JSON.stringify(record)}\n`);
          first = false;
        }
        cursor = batch.next_cursor ?? undefined;
      } while (cursor);
      if (format === 'json')
        write(']}');
      for (const [key, sql] of [
        ['evidencias', 'SELECT * FROM evidencias WHERE pesquisa_id=? ORDER BY id'],
        ['analises', 'SELECT * FROM analises WHERE pesquisa_id=? ORDER BY id'],
        ['documentos', 'SELECT d.*,v.url AS source_url FROM documentos d JOIN documento_vinculos v ON v.documento_id=d.id WHERE v.pesquisa_id=? ORDER BY d.id'],
      ] as const) {
        if (format === 'json')
          write(`,"${key}":[`);
        else
          write(`\n## ${key}\n`);
        first = true;
        for (const row of this.store.db.prepare(sql).iterate(id)) {
          const value: JsonObject = { ...row };
          if (key === 'analises')
            for (const field of ['criteria', 'result', 'evidence_ids'])
              value[field] = JSON.parse(String(value[field]));
          write(format === 'json' ? `${first ? '' : ','}${JSON.stringify(value)}` : `- ${JSON.stringify(value)}\n`);
          first = false;
        }
        if (format === 'json')
          write(']');
      }
      if (format === 'json')
        write('}');
      this.store.db.exec('COMMIT');
      closeSync(fd);
      closed = true;
      renameSync(temporary, path);
      return { path, summary: { unique_records: summary.unique_records, coverage: summary.coverage, truncated: false } };
    }
    catch (error) {
      if (this.store.db.isTransaction)
        this.store.db.exec('ROLLBACK');
      if (!closed)
        closeSync(fd);
      if (existsSync(temporary))
        unlinkSync(temporary);
      throw error;
    }
  }
}
