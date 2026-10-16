import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Service } from '../src/service.js';
import { Store } from '../src/store.js';
import { PncpApi } from '../src/api.js';
import { evidenceSnippets, extractPdf } from '../src/documents.js';
import { queryProgress } from '../src/search.js';
import { setup, temporary, pdfFixture } from './fixtures.js';
const records = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(4, '0') }));
test('repeated pages, changed totals and malformed totals cannot complete coverage', async () => {
  const fixture = setup(() => ({ items: records(10), total: 20 }));
  try {
    const id = String(fixture.service.start(['x']).pesquisa_id);
    await fixture.service.collect(id, 10);
    await assert.rejects(fixture.service.collect(id), /repetida|alterado/);
    const summary = fixture.service.store.summary(id);
    assert.equal(summary.unique_records, 10);
    assert.equal(summary.coverage, 'partial');
    assert.equal(summary.next_page, 2);
    assert.throws(() => queryProgress({ total: '100' }, 1, 10, 0), /Total inválido/);
    assert.throws(() => queryProgress({ total: 0 }, 1, 10, 0), /excedem/);
  }
  finally {
    fixture.close();
  }
});
test('a new term may share IDs with another term, but duplicate IDs in one page fail closed', async () => {
  const fixture = setup(() => ({ items: [{ id: 'same' }, { id: 'same' }], total: 2 }));
  try {
    const id = String(fixture.service.start(['x']).pesquisa_id);
    await assert.rejects(fixture.service.collect(id), /duplicados/);
    assert.equal(fixture.service.store.summary(id).unique_records, 0);
  }
  finally {
    fixture.close();
  }
});
test('collection lease excludes another connection and cancellation prevents commit', async () => {
  let deliver!: (value: unknown) => void;
  const fixture = setup(() => new Promise(resolve => { deliver = resolve; }));
  const second = new Service(fixture.directory);
  try {
    const id = String(fixture.service.start(['x']).pesquisa_id);
    const running = fixture.service.collect(id);
    const rejected = assert.rejects(running);
    await assert.rejects(second.collect(id), /andamento/);
    second.control(id, 'cancelar');
    deliver({ items: [{ id: 'late' }], total: 1 });
    await rejected;
    assert.equal(second.store.summary(id).status, 'cancelled');
    assert.equal(second.store.summary(id).unique_records, 0);
    assert.equal(second.store.db.prepare('SELECT count(*) n FROM coleta_locks').get()?.n, 0);
  }
  finally {
    second.close();
    fixture.close();
  }
});
test('client cancellation discards delayed results and keeps previous checkpoint', async () => {
  let deliver!: (value: unknown) => void;
  const fixture = setup(() => new Promise(resolve => { deliver = resolve; }));
  try {
    const id = String(fixture.service.start(['x']).pesquisa_id);
    const controller = new AbortController();
    const running = fixture.service.collect(id, 10, controller.signal);
    const rejected = assert.rejects(running);
    controller.abort(new Error('client cancelled'));
    deliver({ items: [{ id: 'late' }], total: 1 });
    await rejected;
    assert.equal(fixture.service.store.summary(id).unique_records, 0);
  }
  finally {
    fixture.close();
  }
});
test('a page cap can be raised without repeating the first page', async () => {
  const fixture = setup(p => ({ items: [{ id: String(p.pagina) }], total: 2 }));
  try {
    const id = String(fixture.service.start(['x'], {}, 'busca_rapida', { max_paginas: 1 }).pesquisa_id);
    await fixture.service.collect(id);
    await fixture.service.collect(id);
    assert.equal(fixture.http.calls.length, 1);
    fixture.service.control(id, 'retomar', { max_paginas: 2 }, true);
    await fixture.service.collect(id);
    assert.deepEqual(fixture.http.calls.map(p => p.pagina), [1, 2]);
    assert.equal(fixture.service.store.summary(id).coverage, 'complete');
    fixture.service.control(id, 'retomar');
    await fixture.service.collect(id);
    assert.equal(fixture.http.calls.length, 2);
  }
  finally {
    fixture.close();
  }
});
test('empty searches and misplaced/contradictory inputs cannot silently broaden collection', () => {
  const fixture = setup();
  try {
    assert.throws(() => fixture.service.start([]), /vazia/);
    assert.throws(() => fixture.service.start(['x'], { status: 'todos', situacao: 'vigente' }), /contraditórios/);
    assert.throws(() => fixture.service.start(['x'], { limites: { max_paginas: 1 } }), /separado/);
    assert.throws(() => fixture.service.start(['x'], {}, 'amplo'), /Somente/);
    assert.throws(() => fixture.service.start(['x'], {}, 'busca_rapida', { unknown: 1 }), /não implementado/);
    assert.ok(fixture.service.start([], {}, 'busca_rapida', { max_paginas: 1 }, true).pesquisa_id);
  }
  finally {
    fixture.close();
  }
});
test('invalid IDs and adhesion strings cannot be persisted as valid tri-state data', async () => {
  for (const record of [{ id: '' }, { id: 'a', permite_adesao: 'false' }]) {
    const fixture = setup(() => ({ items: [record], total: 1 }));
    try {
      const id = String(fixture.service.start(['x']).pesquisa_id);
      await assert.rejects(fixture.service.collect(id));
      assert.equal(fixture.service.store.summary(id).unique_records, 0);
    }
    finally {
      fixture.close();
    }
  }
});
test('all records are pageable and exports include every evidence and analysis', async () => {
  const fixture = setup(p => ({ items: records(125).slice((Number(p.pagina) - 1) * 100, Number(p.pagina) * 100), total: 125 }));
  try {
    const id = String(fixture.service.start(['x']).pesquisa_id);
    await fixture.service.collect(id);
    await fixture.service.collect(id);
    const first = fixture.service.store.summary(id, 100);
    assert.ok(first.next_cursor);
    const second = fixture.service.store.summary(id, 100, first.next_cursor!);
    assert.equal(second.results.length, 25);
    assert.equal(second.next_cursor, null);
    assert.equal(fixture.service.store.summary(id, 100, undefined, 100).results.length, 25);
    const doc = await fixture.service.indexDocument(id, 'https://pncp.gov.br/fixture');
    assert.equal(doc.status, 'indexed', JSON.stringify(doc));
    for (let i = 0; i < 125; i++)
      fixture.service.store.addEvidence(id, 'evidence ' + i, 'fixture', 1, String(doc.documento_id));
    const evidence = fixture.service.store.evidence(id, 1)[0]!;
    fixture.service.registerAnalysis(id, { test: true }, { test: true }, [evidence.id]);
    const exported = fixture.service.export(id, 'json');
    const json = JSON.parse(readFileSync(String(exported.path), 'utf8'));
    assert.equal(json.pesquisa.results.length, 125);
    assert.equal(json.evidencias.length, 126);
    assert.equal(json.analises.length, 1);
    assert.equal(json.pesquisa.results_truncated, false);
    const markdown = readFileSync(String(fixture.service.export(id, 'markdown').path), 'utf8');
    assert.match(markdown, /Filtros efetivos/);
    assert.match(markdown, /evidence 124/);
    assert.match(markdown, /## analises/);
  }
  finally {
    fixture.close();
  }
});
test('document cache is idempotent and a shared PDF preserves independent research links', async () => {
  const fixture = setup();
  try {
    const a = String(fixture.service.start(['a']).pesquisa_id), b = String(fixture.service.start(['b']).pesquisa_id);
    const one = await fixture.service.indexDocument(a, 'https://pncp.gov.br/fixture');
    await fixture.service.indexDocument(a, 'https://pncp.gov.br/fixture');
    await fixture.service.indexDocument(b, 'https://pncp.gov.br/fixture');
    assert.equal(fixture.http.downloads, 1);
    assert.equal(fixture.service.store.evidence(a).length, 1);
    assert.equal(fixture.service.store.evidence(b).length, 1);
    assert.equal(fixture.service.store.documents(a)[0]?.id, one.documento_id);
    assert.equal(fixture.service.store.documents(b)[0]?.id, one.documento_id);
    assert.equal(fixture.service.store.db.prepare('SELECT pesquisa_id FROM documentos WHERE id=?').get(String(one.documento_id))?.pesquisa_id, a);
  }
  finally {
    fixture.close();
  }
});
test('blank PDF and RTF have durable reasons and original formats, not successful extraction', async () => {
  const fixture = setup();
  try {
    const id = String(fixture.service.start(['a']).pesquisa_id);
    fixture.http.data = pdfFixture('');
    const blank = await fixture.service.indexDocument(id, 'https://pncp.gov.br/blank');
    assert.equal(blank.document_status, 'needs_ocr');
    fixture.http.data = Buffer.from('{\\rtf1 unsupported}');
    const rtf = await fixture.service.indexDocument(id, 'https://pncp.gov.br/rtf');
    assert.equal(rtf.document_status, 'unsupported');
    const document = fixture.service.store.documentByHash(String(rtf.sha256))!;
    assert.match(String(document.path), /\.rtf$/);
    assert.ok(document.reason);
    assert.ok((fixture.service.evidence(id).pendencias as string[]).some(p => p.includes('OCR')));
  }
  finally {
    fixture.close();
  }
});
test('index persistence failure rolls back document, pages and evidence without mislabeling extraction', async () => {
  const fixture = setup();
  try {
    const id = String(fixture.service.start(['a']).pesquisa_id);
    const original = fixture.service.store.addEvidence.bind(fixture.service.store);
    fixture.service.store.addEvidence = (...args) => { original(...args); throw new Error('simulated disk failure'); };
    await assert.rejects(fixture.service.indexDocument(id, 'https://pncp.gov.br/fixture'), /disk failure/);
    for (const table of ['documentos', 'paginas_documento', 'evidencias', 'documento_vinculos'])
      assert.equal(fixture.service.store.db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n, 0);
  }
  finally {
    fixture.close();
  }
});
test('foreign research IDs and empty analyses fail before downloading or inserting', async () => {
  const fixture = setup();
  try {
    await assert.rejects(fixture.service.indexDocument('deadbeef', 'https://pncp.gov.br/a'), /inexistente/);
    assert.equal(fixture.http.downloads, 0);
    assert.throws(() => fixture.service.registerAnalysis('deadbeef', {}, {}, []), /inexistente/);
    const id = String(fixture.service.start(['a']).pesquisa_id);
    assert.throws(() => fixture.service.registerAnalysis(id, {}, {}, []), /ao menos/);
    assert.throws(() => fixture.service.evidence('deadbeef'), /inexistente/);
    assert.throws(() => fixture.service.store.db.prepare("INSERT INTO analises VALUES('x','deadbeef','{}','{}','[]',CURRENT_TIMESTAMP)").run(), /inexistente/);
  }
  finally {
    fixture.close();
  }
});
test('theme search handles accents/case, literal percent and materializes matches from full text', async () => {
  const fixture = setup();
  try {
    const id = String(fixture.service.start(['a']).pesquisa_id);
    const doc = await fixture.service.indexDocument(id, 'https://pncp.gov.br/fixture');
    fixture.service.store.addPages(String(doc.documento_id), [{ page: 1, text: 'VIGÊNCIA DO CONTRATO ' + '.'.repeat(1000) + ' preço 123' }]);
    const matching = fixture.service.evidence(id, 'vigencia').evidencias as unknown[];
    assert.ok(matching.length > 0);
    assert.equal((fixture.service.evidence(id, '%').evidencias as unknown[]).length, 0);
    assert.ok(evidenceSnippets([{ page: 1, text: 'marca ' + '.'.repeat(1000) + ' preço 123' }]).some(s => s.text.includes('123')));
  }
  finally {
    fixture.close();
  }
});
test('analysis IDs do not collide when clock and result are identical', async () => {
  const fixture = setup();
  const now = Date.now;
  try {
    const id = String(fixture.service.start(['a']).pesquisa_id);
    await fixture.service.indexDocument(id, 'https://pncp.gov.br/fixture');
    const evidence = fixture.service.store.evidence(id, 1)[0]!;
    Date.now = () => 123;
    const a = fixture.service.registerAnalysis(id, { a: 1 }, { same: true }, [evidence.id]);
    const b = fixture.service.registerAnalysis(id, { a: 2 }, { same: true }, [evidence.id]);
    assert.notEqual(a.analise_id, b.analise_id);
  }
  finally {
    Date.now = now;
    fixture.close();
  }
});
test('legacy schema migrates with a restorable backup and unchanged IDs', () => {
  const temp = temporary();
  const file = join(temp.directory, 'pncp.sqlite3');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE pesquisas(id TEXT PRIMARY KEY,termos TEXT,filtros TEXT,status TEXT,next_page INTEGER DEFAULT 1,coverage TEXT DEFAULT 'unknown',reason TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO pesquisas(id,termos,filtros,status) VALUES('abcdef','["legacy"]','{"_search_version":2,"limites":{"max_paginas":5}}','partial');
    CREATE TABLE documentos(id TEXT PRIMARY KEY,pesquisa_id TEXT,url TEXT,final_url TEXT,sha256 TEXT,content_type TEXT,bytes INTEGER,status TEXT,path TEXT,extracted_with TEXT);
    CREATE TABLE paginas_documento(documento_id TEXT,page INTEGER,text TEXT,PRIMARY KEY(documento_id,page));
    INSERT INTO documentos VALUES('aaaaaaaaaaaaaaaa','abcdef','fixture','fixture','fixture','application/pdf',0,'indexed','fixture','old');
    INSERT INTO paginas_documento VALUES('aaaaaaaaaaaaaaaa',1,'');`);
  db.close();
  try {
    const store = new Store(file);
    assert.equal(store.summary('abcdef').pesquisa_id, 'abcdef');
    assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 3);
    assert.equal(store.documents('abcdef')[0]?.status,'needs_ocr');
    store.close();
    const backups = readdirSync(join(temp.directory, 'backups'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(temp.directory, 'backups', backups[0]!), { readOnly: true });
    assert.equal(backup.prepare('SELECT id FROM pesquisas').get()?.id, 'abcdef');
    assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 0);
    assert.equal(backup.prepare('SELECT status FROM documentos').get()?.status,'indexed');
    backup.close();
    const reopened = new Store(file);
    reopened.close();
    assert.equal(readdirSync(join(temp.directory, 'backups')).length, 1);
  }
  finally {
    temp.remove();
  }
});

test('a transient SQLite writer in another process is waited for instead of failing immediately',async()=>{
  const fixture=setup();
  const writer=spawn(process.execPath,['--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');process.stdout.write('READY');setTimeout(()=>{db.exec('COMMIT');db.close();},750);",fixture.service.store.path],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  try{
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('writer readiness timeout')),5000);
      writer.once('error',error=>{clearTimeout(timer);reject(error);});
      writer.stdout.once('data',chunk=>{clearTimeout(timer);assert.match(String(chunk),/READY/);resolve();});
    });
    const started=Date.now();const result=fixture.service.start(['waiting']);
    assert.ok(result.pesquisa_id);assert.ok(Date.now()-started>=100);
    if(writer.exitCode===null)await once(writer,'exit');
  }finally{if(writer.exitCode===null)writer.kill();fixture.close();}
});
test('PDF worker refuses oversized page trees and respects cancellation', async () => {
  await assert.rejects(extractPdf(pdfFixture('', 501)), /500 páginas/);
  const controller = new AbortController();
  controller.abort(new Error('cancel PDF'));
  await assert.rejects(extractPdf(pdfFixture(), controller.signal), /cancel PDF/);
});
test('per-term checkpoints survive closing and reopening the process state', async () => {
  let fail = true;
  const fixture = setup(p => {
    if (p.q === 'second' && fail)
      throw new Error('transient'); return { items: [{ id: String(p.q) }], total: 1 };
  });
  let resumed: Service | undefined, closed = false;
  try {
    const id = String(fixture.service.start(['first', 'second']).pesquisa_id);
    await assert.rejects(fixture.service.collect(id));
    fixture.service.close();
    closed = true;
    fail = false;
    resumed = new Service(fixture.directory, new PncpApi(fixture.http));
    await resumed.collect(id);
    assert.deepEqual(fixture.http.calls.map(p => p.q), ['first', 'second', 'second']);
    assert.equal(resumed.store.summary(id).coverage, 'complete');
  }
  finally {
    resumed?.close();
    if (!closed)
      fixture.service.close();
    fixture.remove();
  }
});
