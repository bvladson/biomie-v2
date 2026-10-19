# Backup e recuperação

| Item | Como | Frequência | Retenção |
|---|---|---|---|
| Banco Postgres (produção) | `pg_dump -Fc` (ou snapshot do provedor) | diário + antes de cada migração/cutover | 30 diários, 12 mensais |
| Migrações | `drizzle/migrations/*.sql` no Git | a cada mudança | permanente |
| Configuração | `.env` do servidor (fora do Git), `private.app_settings` | a cada mudança | cofre de segredos |
| Segredos (App Key/Secret Omie, service role, SMTP, OAuth) | cofre (ex.: 1Password/Vault); no banco ficam em `private.integration_credentials` | ao rotacionar | versão atual + anterior |
| RAW Omie | dentro do banco (reprocessável para Canonical/Gold sem chamar o Omie) | junto do banco | idem banco |
| MariaDB legado | dump final compactado antes do desligamento | uma vez | compliance (5 anos) |

## Restauração
1. Criar banco vazio, `pg_restore -d <db> backup.dump`.
2. Conferir `drizzle/migrations` aplicadas (tabela de journal) e aplicar as novas em ordem.
3. Recadastrar segredos do `.env`; `select public.set_app_base_url('https://<dominio>')`.
4. Rodar Qualidade dos Dados → "Executar agora" e Central de Integridade → "Executar checagens".
5. Teste de restauração trimestral em ambiente de homologação.
