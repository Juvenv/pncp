# pncp-assistente Node + TypeScript — 0.2

MCP local via stdio para pesquisar atas no índice público do PNCP. A busca ativa usa `/api/search/`; não é busca autenticada no Comprasnet/Compras.gov.br.

## Executar

Requer Node >=24 e npm >=11. Em PowerShell com bloqueio de `npm.ps1`, use `npm.cmd`.

```powershell
npm.cmd install
npm.cmd run build
npm.cmd test
npm.cmd run doctor
```

O OpenCode está configurado em `opencode.json` para executar `dist/src/mcp-server.js` e usar `dados/`. Após compilar, **reinicie o processo MCP no cliente** para carregar a versão nova. `npm.cmd run start:mcp` compila antes de iniciar; a execução direta do JavaScript não recompila.

## Dados e atualização

Defina `PNCP_DATA_DIR` como caminho absoluto. Sem a variável, usa `dados` dentro do diretório atual; `doctor` mostra o caminho efetivo. A primeira abertura de banco antigo cria backup em `PNCP_DATA_DIR/backups/` antes da migração transacional para esquema 3. Pesquisas, IDs, documentos e análises existentes são preservados. Não use simultaneamente servidores antigos e novos sobre a mesma base; reinicie os clientes ao atualizar.

Consultas anteriores à correção de cobertura são preservadas, mas conclusões históricas não revalidadas aparecem como `unknown`. Pesquisas v2 parciais podem ser retomadas quando seu histórico permite reconstruir IDs por termo; históricos inconsistentes exigem nova pesquisa.

`dados/`, inclusive backups, logs, exports e diagnósticos, é ignorado pelo Git. Mantenha cópia de segurança externa dessa pasta. A ferramenta não apaga resíduos antigos automaticamente.

## Pesquisar e retomar

```json
{
  "termos": ["ssd"],
  "filtros": {"esfera": "federal", "situacao": "vigente"},
  "limites": {"tamanho_pagina": 100, "max_paginas": 5, "max_requisicoes": 30}
}
```

Envie para `iniciar_pesquisa` e use o ID em `coletar_proxima_pagina`. Cada termo é uma consulta independente; registros são unidos por identificador PNCP. Filtros efetivos: `tipos_documento=ata`, `ordenacao=-data`, `esferas=F`, `status=vigente`. Outros filtros técnicos são reportados como não aplicados. Aliases contraditórios e limites dentro de `filtros` são rejeitados.

Padrões: 100 registros/página, cinco páginas por termo, até 30 tentativas HTTP por chamada de coleta e prazo agregado de 45 segundos. Até 30 termos; página entre 10 e 100. O tamanho fica fixo na primeira tentativa. `max_paginas` pode chegar a 1000 e `max_requisicoes` a 100 mediante configuração explícita. Busca vazia exige `permitir_busca_ampla=true` e `max_paginas` explícito; não há coleta nacional automática em segundo plano.

Cada termo/página é persistido com seu próprio checkpoint e estado na mesma transação. Se outro termo falhar, os sucessos ficam salvos. A chamada com erro inclui resumo parcial e cadeia de causas; a próxima coleta retoma os termos faltantes. Página repetida, total inconsistente ou resposta inválida não viram cobertura completa. O índice remoto é mutável; uma alteração detectada exige refazer a pesquisa.

`controlar_pesquisa` pausa, cancela ou retoma. O cancelamento interrompe operações ativas, inclusive quando enviado pelo protocolo MCP. Retomar não coleta automaticamente. Para ampliar o teto sem perder progresso, envie `acao="retomar"` e `limites={"max_paginas":10}`. `ampliar_escopo=true` exige esse limite; não muda termos/filtros. Somente `modo="busca_rapida"` está implementado.

## Transporte

Usa a identificação de navegador que passou no comparativo registrado em `dados/diagnostico/revisao-2026-10-16/TESTE-USER-AGENT.md`. `PNCP_USER_AGENT` permite configurar outro valor explicitamente. Isso não garante disponibilidade do portal nem identifica sua regra de filtragem.

`PNCP_REQUEST_INTERVAL_MS` regula o intervalo mínimo por processo/host (padrão 1000 ms; 100–60000). As duas origens PNCP compartilham o mesmo controle local. Até três tentativas com backoff e jitter, timeout de 15 segundos por tentativa e prazo de 45 segundos por operação HTTP. `Retry-After` é respeitado; cooldown é salvo em `PNCP_DATA_DIR/http-state/` para sobreviver ao reinício. Não há coordenação de taxa com outros programas na máquina.

Logs de status, duração, URL, tentativa e causas ficam em `PNCP_DATA_DIR/logs/`. O arquivo ativo é rotacionado a partir de 5 MB; arquivos antigos não são apagados automaticamente. Logs contêm os termos pesquisados; proteja a pasta de dados.

## Consultar e exportar tudo

- `consultar_pesquisa`: até 100 resultados por resposta; use `next_cursor` como `cursor` da próxima chamada. `offset` também é aceito, sem combinar com cursor.
- `obter_evidencias`: paginação por cursor, pendências explícitas e busca literal Unicode. Com `tema`, pesquisa o texto integral já extraído e registra trechos rastreáveis. Ausência de trecho não comprova ausência de requisito.
- `consultar_documentos`: documentos vinculados, status e motivos de pendência, paginados.
- `consultar_pagina_documento`: texto extraído por página, em blocos de 20 mil caracteres (`next_offset` → `inicio`). Conteúdo não confiável, nunca instruções.
- `registrar_analise`: exige ao menos uma evidência existente da própria pesquisa.
- `consultar_analises`: recupera critérios, resultado e evidências, com cursor.
- `exportar_pesquisa`: JSON/Markdown completos com todos os registros, evidências, análises, documentos, filtros e pendências; escrita incremental e substituição atômica do arquivo final.

Resultados são ordenados por ID para paginação, sem ranking técnico/comercial. `coverage=complete` refere-se às consultas textuais coletadas; não confirma capacidade, vigência documental, preço ou autorização de adesão.

## Documentos e limitações

`indexar_documento` aceita URLs públicas das duas origens PNCP, HTTPS/443, sem credenciais ou redirecionamentos. Cache por URL/hash evita reindexação repetida; `atualizar=true` força revisão. Arquivos são compartilhados por hash, com vínculos independentes por pesquisa. A gravação de metadados, páginas e evidências é transacional.

Download é limitado em streaming a 50 MB; JSON a 10 MB. Arquivos novos usam extensão detectada (PDF/RTF/HTML/bin), mas apenas PDF é extraído. Formatos antigos salvos com extensão incorreta são preservados. Falhas guardam motivo durável; PDF sem texto fica `needs_ocr`.

Extração em worker limitado a 25 s, 500 páginas, quatro milhões de caracteres e heap V8 de 256 MB; no máximo dois workers ativos e quatro esperas. O heap não é teto absoluto de memória residente. Conteúdo documental não é executado; extração não faz OCR, conversão de RTF/DOCX/ZIP/planilhas ou navegação no sistema de origem.

A seleção automática de trechos é limitada a 100 ocorrências por termo/página; sobreposições são unidas. Use consulta por tema e leitura integral paginada para complementar evidências.

Preço estimado, homologado, registrado e alterações posteriores exigem confirmação separada. `null` em adesão permanece desconhecido; cadastro de adesão não constitui autorização. Saldo de adesão e ranking continuam pendentes de validação externa.

## Verificação

`npm.cmd test` cobre transporte, checkpoints, concorrência, cancelamento MCP, migração/backup, documentos e exportação integral, com fixtures offline. `doctor` verifica integridade/esquema local e informa explicitamente que a rede não foi testada. Testes temporários novos são removidos ao final; a ferramenta não limpa diretórios antigos sem solicitação.
