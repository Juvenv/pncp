import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { Service } from '../src/service.js';
import { PncpApi } from '../src/api.js';
import { HttpClient } from '../src/http.js';
import { searchFilters, queryProgress } from '../src/search.js';

class FakeHttp extends HttpClient {
  calls: Array<Record<string, string | number | undefined>> = [];
  constructor(readonly respond: (params: Record<string, string | number | undefined>) => unknown) { super(); }
  override async json(_base: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> { this.calls.push(params); return this.respond(params); }
}
function setup(respond: FakeHttp['respond']) {
  const http = new FakeHttp(respond);
  const service = new Service(mkdtempSync(join(process.cwd(), 'dados/test-search-')), new PncpApi(http));
  return { http, service };
}

test('portal query uses federal/current aliases and reports pending technical filters', async () => {
  const { http, service } = setup(() => ({ items: [{ id: 'a', permite_adesao: null }], total: 1 }));
  try {
    const start = service.start(['ssd'], { esfera: 'federal', situacao: 'vigente', capacidade: ['1 TB', '2 TB'] }, 'busca_rapida', { tamanho_pagina: 100 });
    const result = await service.collect(String(start.pesquisa_id));
    assert.deepEqual(http.calls, [{ tipos_documento: 'ata', ordenacao: '-data', q: 'ssd', pagina: 1, tam_pagina: 100, status: 'vigente', esferas: 'F' }]);
    assert.deepEqual(result.filtros_nao_aplicados, ['capacidade']);
    assert.equal(result.coverage, 'complete');
    assert.equal(service.store.summary(String(start.pesquisa_id)).results[0]?.adesao, null);
  } finally { service.close(); }
});

test('synonyms are independent, deduplicated, and only unfinished queries advance', async () => {
  const { http, service } = setup(params => params.q === 'ssd'
    ? { items: [{ id: 'shared' }], total: 1 }
    : params.pagina === 1 ? { items: [{ id: 'shared' }], total: 2 } : { items: [{ id: 'second' }], total: 2 });
  try {
    const id = String(service.start(['ssd', 'unidade de estado sólido']).pesquisa_id);
    assert.equal((await service.collect(id)).coverage, 'partial');
    const result = await service.collect(id);
    assert.equal(result.unique_records, 2);
    assert.equal(result.coverage, 'complete');
    assert.deepEqual(http.calls.map(p => [p.q, p.pagina]), [['ssd', 1], ['unidade de estado sólido', 1], ['unidade de estado sólido', 2]]);
    await service.collect(id);
    assert.equal(http.calls.length, 3);
  } finally { service.close(); }
});

test('total prevents early completion and page size cannot change after checkpoint', async () => {
  const { service } = setup(() => ({ items: [{ id: 'a' }], total: 20 }));
  try {
    const id = String(service.start(['ssd']).pesquisa_id);
    assert.equal((await service.collect(id, 100)).coverage, 'partial');
    await assert.rejects(service.collect(id, 10), /tamanho de página/);
    assert.equal(service.store.summary(id).next_page, 2);
  } finally { service.close(); }
});

test('failed batch does not commit partial synonyms; retry starts from same checkpoint', async () => {
  let fail = true;
  const { service } = setup(params => {
    if (params.q === 'second' && fail) throw new Error('network');
    return { items: [{ id: String(params.q) }], total: 1 };
  });
  try {
    const id = String(service.start(['first', 'second']).pesquisa_id);
    await assert.rejects(service.collect(id), /network/);
    assert.equal(service.store.summary(id).next_page, 1);
    assert.equal(service.store.summary(id).unique_records, 0);
    fail = false;
    assert.equal((await service.collect(id)).unique_records, 2);
  } finally { service.close(); }
});

test('limits, legacy searches and display truncation never imply full validated coverage', async () => {
  const { http, service } = setup(() => ({ items: Array.from({ length: 12 }, (_, i) => ({ id: String(i) })), total: 30 }));
  try {
    const id = String(service.start(['ssd'], {}, 'busca_rapida', { max_paginas: 1 }).pesquisa_id);
    const result = await service.collect(id);
    assert.equal(result.status, 'partial');
    assert.equal(result.results_truncated, true);
    assert.equal(result.results_returned, 10);
    await service.collect(id);
    assert.equal(http.calls.length, 1);
    const legacy = service.store.start(['ssd'], { esfera: 'federal' });
    service.store.setStatus(legacy, 'completed', 'complete');
    assert.equal(service.store.summary(legacy).coverage, 'unknown');
    await assert.rejects(service.collect(legacy), /legada/);
  } finally { service.close(); }
});

test('an unexpectedly empty page preserves partial state', async () => {
  const { service } = setup(() => ({ items: [], total: 29 }));
  try {
    const id = String(service.start(['ssd']).pesquisa_id);
    await assert.rejects(service.collect(id), /Página vazia/);
    assert.equal(service.store.summary(id).coverage, 'unknown');
    assert.equal(service.store.summary(id).next_page, 1);
  } finally { service.close(); }
});

test('invalid filters cannot silently broaden the search', () => {
  assert.throws(() => searchFilters({ esfera: 'invalid' }));
  assert.throws(() => searchFilters({ status: 'invalid' }));
  assert.throws(() => searchFilters({ esferas: [] }));
  assert.throws(() => searchFilters({ tipo_documento: 'contrato' }));
});

test('exactly full final page uses total; remaining-page flags preserve pending coverage', () => {
  assert.equal(queryProgress({ total: 100 }, 100, 100, 0).completa, true);
  assert.equal(queryProgress({ paginasRestantes: true }, 1, 100, 0).completa, false);
  assert.equal(queryProgress({ paginasRestantes: 1 }, 1, 100, 0).completa, false);
});
