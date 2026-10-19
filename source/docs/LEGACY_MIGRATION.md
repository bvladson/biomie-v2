# Migração de dados próprios do BIOMIE antigo (MariaDB)

Dados que vêm do Omie **não** são migrados do MariaDB (vendedores, clientes, produtos, notas, pedidos, títulos).
Migrar apenas o que só existe no BIOMIE antigo:

| Dado legado | Destino no BIOMIE 2.0 | Observação |
|---|---|---|
| Metas por vendedor/mês e níveis | `sales_targets` (level BASE/ACTIVE/CHALLENGE) | vendedor mapeado por `sellers.external_id` (código Omie), nunca por nome |
| Equipes e gestores | `sales_teams`, `sales_team_members`, `sales_team_managers` com `valid_from/valid_to` | manter histórico |
| Configurações/regras | `metric_config` | revisar com o negócio antes |
| Planos de ação/observações | `flight_plan_actions` | opcional |
| Agenda, cobranças, enriquecimentos | avaliar caso a caso | não existem tabelas ainda |

Procedimento: exportar CSV de cada tabela do MariaDB → script de carga idempotente (upsert por chave natural) → conferir totais na Central de Integridade.
