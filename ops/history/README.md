# Scripts históricos do deploy de 19/10/2026 (manhã)

Executados pelo agente anterior antes da reconstrução do deploy. Ficam só como
registro do que foi feito na VPS. **Não rode estes scripts**: vários foram
substituídos (gateway, migrações, sincronização, backup) e alguns geravam
segredos em arquivo. Os scripts vigentes estão em `ops/` (20 em diante) e o
procedimento em `source/docs/GO_LIVE_RUNBOOK.md`.

Removidos por segurança: `fetch_test_context.py` e `run_tests.py`, que gravavam a
chave de serviço em `ops/.test-context.json`.
