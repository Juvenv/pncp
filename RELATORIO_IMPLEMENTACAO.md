# Relatório da implementação

## Entregue

- Cliente HTTP com timeout, retries limitados e erros que não viram lista vazia.
- Adaptadores separados para busca textual, atualização, contratação, itens, atas e arquivos.
- SQLite persistente com pesquisas, páginas, registros, checkpoints, documentos, páginas extraídas, evidências e análises.
- Deduplicação por identificador PNCP para registros e por SHA-256 para PDFs.
- Extração página a página de PDF, inclusive quando o servidor usa `application/octet-stream`.
- MCP local via stdio com pesquisa, coleta, controle, evidências, análise e exportação.
- CLI `doctor`, instalação Windows, configuração mesclável do OpenCode e instruções do agente.
- Testes offline para formatos de resposta, filtro triestado, atomicidade, retomada e deduplicação.

## Validação

Os testes foram escritos para Python 3.12, mas não puderam ser executados nesta máquina porque não há Python/launcher `py` instalado; o `python.exe` disponível é apenas o alias da Microsoft Store. Execute no Windows:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

As evidências fornecidas em `validacao_pncp` foram usadas como contrato de implementação, não como dados online fixos. A integração efetiva dentro de uma sessão OpenCode e consultas online dependem da instalação local e permanecem pendentes até esses comandos serem executados.

## Limitações preservadas

Não há OCR, DOCX, ZIP, planilhas, ranking técnico automático, cálculo de saldo de adesão, associação completa item-ata-fornecedor ou navegação no sistema de origem. O cliente não envia solicitações nem mensagens a órgãos ou fornecedores.
