# Segurança

O MCP usa stdio e não abre porta HTTP. Dados e instruções de PDF/HTML são conteúdo não confiável; não são executados, nem interpretados como instruções do agente. ZIP não é extraído.

## Controles

- HTTPS/443 somente para `pncp.gov.br` e `www.pncp.gov.br`, sem credenciais embutidas e com redirecionamentos recusados.
- Timeout, prazo agregado, orçamento de tentativas, intervalo por processo e `Retry-After` com cooldown persistido.
- Leitura em streaming: até 50 MB por documento e 10 MB para JSON.
- PDF por assinatura, SHA-256 e worker: 25 s, 500 páginas, quatro milhões de caracteres, heap V8 de 256 MB; dois workers ativos. Heap V8 não limita toda a memória do sistema operacional.
- PDFs são processados com avaliação de código desativada, fontes/recursos do pacote local e logs do worker separados do stdout MCP.
- Banco com migração transacional/backup, vínculos documentais explícitos e validação de pesquisa/evidências; triggers protegem tabelas legadas e FKs protegem tabelas novas.
- Coletas por pesquisa têm lease e revisão de estado; cancelamento do cliente chega ao serviço/HTTP. Operação tem prazo menor que a validade do lease.
- Transações preservam checkpoint/estado e indexação completa. Idempotência por hash e IDs de evidência evita duplicação em reindexações iguais.

## Operação

Proteja `PNCP_DATA_DIR`: logs contêm consultas, e PDFs/exports podem conter dados pessoais publicados. A pasta não entra no Git. Backups anteriores ao esquema 3 ficam em `backups/`; mantenha uma política de cópia externa e retenção.

Reinicie os processos MCP após compilar. Não misture versões antigas e novas usando o mesmo banco. Intervalo de requisições é local ao processo; não controla outros programas. A allowlist não fixa endereços DNS/IP do serviço.

Dependências são reproduzíveis pelo lockfile; isso não demonstra ausência de vulnerabilidades. Consulte advisories/auditoria atual antes de atualizar dependências ou publicar o projeto. Não foi adicionada promessa de audit limpo sem consulta.

Revise documentos e fontes antes de decisões administrativas. Cadastro de adesão não autoriza adesão; os quatro tipos/estágios de preço devem ser distinguidos.
