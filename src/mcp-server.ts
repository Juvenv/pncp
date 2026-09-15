import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Service } from './service.js';

const server = new McpServer({ name: 'pncp-assistente-node', version: '0.1.0' });
const service = (): Service => new Service();
const jsonResult = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

server.registerTool('iniciar_pesquisa', {
  description: 'Cria pesquisa PNCP persistida e mostra filtros interpretados.',
  inputSchema: { termos: z.array(z.string().max(200)).max(30).optional(), filtros: z.record(z.unknown()).optional(), modo: z.string().max(40).optional(), limites: z.record(z.unknown()).optional() }
}, async ({ termos, filtros, modo, limites }) => { const s = service(); try { return jsonResult(s.start(termos ?? [], filtros ?? {}, modo ?? 'busca_rapida', limites ?? {})); } finally { s.close(); } });

server.registerTool('consultar_pesquisa', {
  description: 'Consulta pesquisa persistida ou lista pesquisas recentes.',
  inputSchema: { pesquisa_id: z.string().regex(/^[a-f0-9-]{1,40}$/i).optional(), limite: z.number().int().min(1).max(100).default(10) }
}, async ({ pesquisa_id, limite }) => { const s = service(); try { return jsonResult(pesquisa_id ? s.store.summary(pesquisa_id, limite) : { pesquisas: s.store.list(limite) }); } finally { s.close(); } });

server.registerTool('coletar_proxima_pagina', {
  description: 'Consulta uma página do PNCP e avança checkpoint somente após gravar o lote.',
  inputSchema: { pesquisa_id: z.string().regex(/^[a-f0-9-]{1,40}$/i), tamanho_pagina: z.number().int().min(10).max(500).default(10) }
}, async ({ pesquisa_id, tamanho_pagina }) => { const s = service(); try { return jsonResult(await s.collect(pesquisa_id, tamanho_pagina)); } finally { s.close(); } });

server.registerTool('controlar_pesquisa', {
  description: 'Pausa, retoma ou cancela uma pesquisa sem apagar histórico.',
  inputSchema: { pesquisa_id: z.string().regex(/^[a-f0-9-]{1,40}$/i), acao: z.enum(['pausar', 'retomar', 'cancelar']), ampliar_escopo: z.boolean().default(false) }
}, async ({ pesquisa_id, acao, ampliar_escopo }) => { const s = service(); try { s.store.setStatus(pesquisa_id, { pausar: 'paused', retomar: 'running', cancelar: 'cancelled' }[acao], undefined, ampliar_escopo ? 'Escopo ampliado' : null); return jsonResult(s.store.summary(pesquisa_id)); } finally { s.close(); } });

server.registerTool('indexar_documento', {
  description: 'Baixa e indexa PDF público do PNCP com hash e evidências por página.',
  inputSchema: { pesquisa_id: z.string().regex(/^[a-f0-9-]{1,40}$/i), url: z.string().url().max(2048) }
}, async ({ pesquisa_id, url }) => { const s = service(); try { return jsonResult(await s.indexDocument(pesquisa_id, url)); } finally { s.close(); } });

server.registerTool('obter_evidencias', {
  description: 'Retorna trechos delimitados de documentos indexados.',
  inputSchema: { pesquisa_id: z.string().regex(/^[a-f0-9-]{1,40}$/i), tema: z.string().max(100).optional(), limite: z.number().int().min(1).max(100).default(20) }
}, async ({ pesquisa_id, tema, limite }) => { const s = service(); try { return jsonResult(s.evidence(pesquisa_id, tema, limite)); } finally { s.close(); } });

server.registerTool('registrar_analise', {
  description: 'Persiste análise estruturada somente com IDs de evidências existentes.',
  inputSchema: { pesquisa_id: z.string().regex(/^[a-f0-9-]{1,40}$/i), criterios: z.record(z.unknown()), resultado: z.record(z.unknown()), evidencias: z.array(z.string()).max(100) }
}, async ({ pesquisa_id, criterios, resultado, evidencias }) => { const s = service(); try { return jsonResult(s.registerAnalysis(pesquisa_id, criterios, resultado, evidencias)); } finally { s.close(); } });

server.registerTool('exportar_pesquisa', {
  description: 'Exporta relatório delimitado em Markdown ou JSON.',
  inputSchema: { pesquisa_id: z.string().regex(/^[a-f0-9-]{1,40}$/i), formato: z.enum(['markdown', 'json']).default('markdown') }
}, async ({ pesquisa_id, formato }) => { const s = service(); try { return jsonResult(s.export(pesquisa_id, formato)); } finally { s.close(); } });

await server.connect(new StdioServerTransport());
