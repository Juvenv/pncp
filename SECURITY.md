# Segurança

## Modelo de ameaça

Respostas HTTP, PDFs e textos indexados são dados não confiáveis. O servidor MCP não interpreta conteúdo documental como instrução, não executa arquivos, não abre arquivos compactados e não envia ações ao PNCP.

## Controles implementados

- Somente `https://pncp.gov.br` e `https://www.pncp.gov.br` são aceitos para rede.
- Redirecionamentos HTTP são recusados, evitando troca silenciosa de origem.
- Timeout de rede, retries limitados a falhas transitórias e limite de 50 MB para downloads.
- Validação de argumentos MCP com Zod e limites para termos, IDs, páginas e resultados.
- Dados ficam em `PNCP_DATA_DIR`, separado do código-fonte.
- PDFs são identificados por assinatura e SHA-256 antes da extração.
- Dependências são fixadas por `package-lock.json`; `npm audit --omit=dev` deve permanecer sem vulnerabilidades.

## Operação segura

Use uma pasta de dados com permissões restritas e não exponha o processo MCP por HTTP. Não coloque tokens ou credenciais em `PNCP_DATA_DIR`. Revise URLs e evidências antes de qualquer decisão administrativa.
