import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Service } from '../src/service.js';
import { temporary, pdfFixture } from './fixtures.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
test('real MCP paginates complete data, recovers analyses and exports without truncation', async () => {
  const temp = temporary(), seed = new Service(temp.directory);
  const id = String(seed.start(['fixture']).pesquisa_id);
  seed.store.ingest(id, 1, { items: Array.from({ length: 125 }, (_, i) => ({ id: String(i).padStart(4, '0') })) });
  seed.store.setStatus(id, 'completed', 'complete');
  const data = pdfFixture(), hash = createHash('sha256').update(data).digest('hex'), file = join(temp.directory, 'fixture.pdf');
  writeFileSync(file, data);
  seed.store.addDocument(hash, id, 'https://pncp.gov.br/fixture', 'https://pncp.gov.br/fixture', hash, 'application/pdf', data.length, 'indexed', file, 'fixture');
  seed.store.addPages(hash, [{ page: 1, text: 'marca fixture' }]);
  const evidence = [];
  for (let i = 0; i < 125; i++)
    evidence.push(seed.store.addEvidence(id, 'marca ' + i, 'fixture', 1, hash));
  seed.registerAnalysis(id, { fixture: true }, { fixture: true }, [evidence[0]!]);
  seed.close();
  const client = new Client({ name: 'regression', version: '1' }), transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', resolve('src/mcp-server.ts')], env: { ...process.env, PNCP_DATA_DIR: temp.directory } });
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  const value = (r: CallToolResult) => {
    assert.notEqual(r.isError, true); const first = r.content[0]; assert.equal(first?.type, 'text'); return JSON.parse((first as {
      text: string;
    }).text);
  };
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(t => t.name);
    assert.ok(tools.includes('consultar_analises'));
    assert.ok(tools.includes('consultar_pagina_documento'));
    const first = value(await call('consultar_pesquisa', { pesquisa_id: id, limite: 100 }));
    const next = value(await call('consultar_pesquisa', { pesquisa_id: id, limite: 100, cursor: first.next_cursor }));
    assert.equal(first.results.length + next.results.length, 125);
    assert.equal(value(await call('consultar_pesquisa', { pesquisa_id: id, limite: 100, offset: 100 })).results.length, 25);
    const e1 = value(await call('obter_evidencias', { pesquisa_id: id, limite: 100 })), e2 = value(await call('obter_evidencias', { pesquisa_id: id, limite: 100, cursor: e1.next_cursor }));
    assert.equal(e1.evidencias.length + e2.evidencias.length, 125);
    assert.equal(value(await call('consultar_analises', { pesquisa_id: id })).analises.length, 1);
    assert.equal(value(await call('consultar_pagina_documento', { pesquisa_id: id, documento_id: hash, pagina: 1 })).text, 'marca fixture');
    const exported = value(await call('exportar_pesquisa', { pesquisa_id: id, formato: 'json' }));
    const report = JSON.parse(readFileSync(exported.path, 'utf8'));
    assert.equal(report.pesquisa.results.length, 125);
    assert.equal(report.evidencias.length, 125);
    assert.equal(report.analises.length, 1);
    assert.equal((await call('registrar_analise', { pesquisa_id: 'deadbeef', criterios: {}, resultado: {}, evidencias: [evidence[0]] })).isError, true);
  }
  finally {
    await client.close();
    temp.remove();
  }
});
test('MCP timeout cancellation reaches an in-flight request and no late commit occurs', async () => {
  const temp = temporary();
  writeFileSync(join(temp.directory, 'resposta.json'), JSON.stringify({ delay: 400, payload: { items: [{ id: 'late' }], total: 1 } }));
  const client = new Client({ name: 'cancellation-regression', version: '1' }), transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', resolve('test/mcp-fixture-server.ts')], env: { ...process.env, PNCP_DATA_DIR: temp.directory, PNCP_REQUEST_INTERVAL_MS: '100' } });
  try {
    await client.connect(transport);
    const created = await client.callTool({ name: 'iniciar_pesquisa', arguments: { termos: ['fixture'] } }) as CallToolResult;
    const id = JSON.parse((created.content[0] as {
      text: string;
    }).text).pesquisa_id;
    await assert.rejects(client.callTool({ name: 'coletar_proxima_pagina', arguments: { pesquisa_id: id } }, undefined, { timeout: 150 }));
    assert.equal(existsSync(join(temp.directory, 'fetch-started')), true);
    await delay(600);
    const result = await client.callTool({ name: 'consultar_pesquisa', arguments: { pesquisa_id: id } }) as CallToolResult;
    const state = JSON.parse((result.content[0] as {
      text: string;
    }).text);
    assert.equal(state.unique_records, 0);
    assert.notEqual(state.status, 'completed');
  }
  finally {
    await client.close();
    temp.remove();
  }
});
