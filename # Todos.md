# Estado do projeto — 0.2.0

- [x] Transporte com identificação validada, Retry-After, cooldown persistido, backoff, orçamento e telemetria.
- [x] Checkpoint por termo, retomada após reinício, lease e cancelamento propagado.
- [x] Validação de cobertura, IDs, tipos de adesão, filtros e limites.
- [x] Paginação local e exportação integral de resultados/evidências/análises/documentos.
- [x] Vínculos documentais independentes, cache, indexação transacional e worker PDF limitado.
- [x] Migração com backup, classificação de PDF sem texto, doctor e documentação atualizados.
- [x] 37 testes offline aprovados; TypeScript e build concluídos; consulta online MCP com HTTP 200 na primeira tentativa.

Evidências e limitações: `dados/diagnostico/correcoes-2026-10-16/CORRECOES-APLICADAS.md`.

Após atualizar, reinicie o processo MCP para carregar `dist/src/mcp-server.js`. OCR, outros formatos, ranking, saldo/autorização de adesão e validação de preços continuam exigindo trabalho específico.
