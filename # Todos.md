# Todos
[✓] Verificar ferramentas Node/TypeScript disponíveis e estrutura atual
[✓] Definir arquitetura Node/TypeScript e controles de segurança
[✓] Implementar cliente PNCP, persistência SQLite, documentos e MCP
[✓] Adicionar testes, configuração OpenCode e documentação
[✓] Executar validações Node/TypeScript e corrigir problemas
Foi criada a versão Node.js + TypeScript em:
pncp-assistente-node/
Inclui:
- MCP local via stdio.
- APIs PNCP com fetch.
- SQLite nativo usando node:sqlite.
- Persistência de pesquisas e checkpoints.
- Retomada de páginas sem duplicação.
- Extração de PDFs com pdfjs-dist.
- Evidências por página e hash SHA-256.
- Exportação JSON/Markdown.
- Validação com Zod.
- Configuração para OpenCode.
- Testes automatizados.
- SECURITY.md com controles e modelo de ameaça.
Validações executadas com sucesso:
npm run build       OK
npm test            3 testes aprovados
npm run doctor      OK
npm audit --omit=dev
found 0 vulnerabilities
Controles de segurança implementados:
- Apenas HTTPS para pncp.gov.br.
- Redirecionamentos recusados.
- Timeout e retries limitados.
- Download máximo de 50 MB.
- PDFs tratados como dados não confiáveis.
- Nenhuma execução de conteúdo documental.
- MCP sem porta HTTP pública.
- IDs, páginas, termos e limites validados.
- Dependências travadas em package-lock.json.
Para usar:
cd pncp-assistente-node
npm install
npm run build
npm run start:mcp
A configuração de integração está em:
pncp-assistente-node/opencode.json.example