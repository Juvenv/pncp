# pncp-assistente Node + TypeScript

Implementação Node.js do cliente definido no prompt `..\PROMPT_CRIACAO_PNCP_OPENCODE.md`, usando as evidências de `..\validacao_pncp`. A versão Python existente foi preservada separadamente.

## Requisitos

- Node.js 24 ou superior
- npm 11 ou superior

O projeto usa `node:sqlite`, portanto não precisa de compilador nativo ou banco externo.

## Instalação e testes

```powershell
cd pncp-assistente-node
npm install
npm run build
npm test
npm run doctor
```

## Configuração MCP no OpenCode

Mescle esta entrada à configuração existente, sem remover outros MCPs:

```json
{
  "mcp": {
    "pncp": {
      "type": "local",
      "command": [
        "node",
        "C:/CAMINHO/pncp-assistente-node/dist/src/mcp-server.js"
      ],
      "enabled": true,
      "environment": {
        "PNCP_DATA_DIR": "C:/CAMINHO/pncp-assistente-node/dados"
      }
    }
  }
}
```

Após `npm run build`, o artefato fica em `dist/src/mcp-server.js` porque o `tsconfig.json` mantém a pasta `src` dentro do diretório de saída. O script `npm run start:mcp` executa o build automaticamente antes de iniciar o servidor.

## Ferramentas MCP

`iniciar_pesquisa`, `consultar_pesquisa`, `coletar_proxima_pagina`, `controlar_pesquisa`, `indexar_documento`, `obter_evidencias`, `registrar_analise` e `exportar_pesquisa`.

O cliente não inicia uma coleta nacional silenciosa. Cada página é persistida antes do checkpoint avançar; falhas resultam em `partial`/`unknown`. Documentos baixados são identificados por SHA-256, extraídos por página e guardados em `PNCP_DATA_DIR/documents`.

## Segurança e limitações

- Requisições externas aceitam apenas `https://pncp.gov.br` e `https://www.pncp.gov.br`.
- Redirecionamentos são recusados para evitar SSRF e troca silenciosa de origem.
- Downloads têm timeout e limite de 50 MB; não são executados nem descompactados.
- O servidor MCP usa stdio; não abre porta HTTP.
- Dados de PDF/HTML são tratados como conteúdo não confiável.
- OCR, DOCX, ZIP, planilhas, ranking técnico completo, saldo de adesão e sistema de origem permanecem pendentes.

O relatório `RELATORIO_IMPLEMENTACAO.md` na variante Python registra as limitações herdadas da validação original. Totais online não são expectativas fixas de testes.
