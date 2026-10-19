# Banco novo na VPS: execução e limites

O aplicativo depende de PostgreSQL + GoTrue (Auth) + PostgREST, com gateway HTTP
expondo `/auth/v1` e `/rest/v1`. PostgreSQL sozinho não substitui Supabase.
Storage, Realtime e Studio não são necessários às funcionalidades atuais.
O gateway deve remover o prefixo correspondente antes de encaminhar aos serviços.

## Ordem executável

1. Criar um banco PostgreSQL novo, volume persistente e rede privada. O banco do
   legado permanece separado. Criar senhas de `authenticator` e
   `supabase_auth_admin` fora dos arquivos versionados.
2. Executar `deploy/db/00_supabase_compat.sql` como dono do banco. O script cria
   os papéis da API, o schema `auth`, as funções `auth.uid/role/jwt` e `pgcrypto`
   no schema `extensions`. Não cria `auth.users` nem usuários fictícios.
3. Iniciar GoTrue com a conexão de `supabase_auth_admin`, URL pública correta,
   chave JWT compartilhada com PostgREST e cadastro público desabilitado.
   Aguardar as migrations do próprio GoTrue criarem `auth.users`.
   Executar `00_supabase_compat.sql` novamente depois do primeiro boot do Auth:
   versões do GoTrue redefinem `auth.uid/role`; o segundo passe restaura suporte
   também a `request.jwt.claims` usado pelo PostgREST. Essas funções pertencem a
   `supabase_auth_admin`, permitindo as migrations do GoTrue sem conflito de dono.
4. Gerar e aplicar migrations com Python 3 e `psql`:

   ```sh
   python3 scripts/render-vps-migrations.py > /tmp/biomie-migrations.sql
   psql -v ON_ERROR_STOP=1 -f /tmp/biomie-migrations.sql
   psql -v ON_ERROR_STOP=1 -f deploy/db/verify_security.sql
   ```

   A conexão deve ser fornecida pelo ambiente/cofre, sem incluir senhas na linha
   de comando. Em Docker, encaminhar o arquivo com `docker compose exec -T db psql`.

5. Iniciar PostgREST com login `authenticator`, schema exposto `public`, papel
   anônimo `anon`, search path adicional `extensions` e verificação JWT com a
   mesma chave do Auth. Os papéis `authenticated` e `service_role` vêm do JWT.
   A chave de serviço é exclusivamente do servidor; a chave pública é anônima.
6. Copiar o token `private.job_secrets.scheduler` diretamente para o ambiente
   protegido do worker, sem imprimi-lo. Definir `set_app_base_url` usando uma
   requisição service-role ou sessão administrativa autorizada.
7. Provisionar usuários e acessos explicitamente. `ensure_app_profile()` cria
   somente VIEWER; nenhum primeiro visitante recebe SUPER_ADMIN. Uma conta
   administrativa deve ser escolhida a partir da identidade já validada no
   legado ou criada pelo operador pela API administrativa do Auth.
8. Executar novamente o render/aplicação para verificar idempotência; o ledger
   `private.vps_schema_migrations` registra SHA256 do SQL efetivamente aplicado.
   Validar login, escopo empresarial, telas e exportações antes do cutover.

## Migrations e DEMO

Os arquivos entregues `0000` a `0015` são preservados. A versão renderizada de
`0003` cria apenas o segredo e `verify_job_token`; não instala `pg_cron/pg_net`
nem agenda a URL de preview. O worker externo da VPS faz o agendamento.
`scheduler_status()` trata ausência de `cron` como indisponível; isso não significa
que o worker externo deixou de funcionar.

As migrations `0016` a `0029` acrescentam bootstrap seguro, leases entre processos,
integridade empresarial, precisão de quantidades, autorização de documentos,
fronteiras de capacidade financeira, prontidão e snapshots atômicos.
Nenhum dado DEMO é excluído. Empresas reais devem ser criadas com `is_demo=false`
e `data_source='OMIE_SHADOW'`; não renomear/reciclar uma empresa DEMO para representar
uma empresa real.

## Contratos que a carga precisa preservar

- Identidade: empresa + fonte + ID Omie, nunca nome como chave. IDs do MariaDB
  e UUIDs novos precisam de mapa persistente.
- O legado calcula base comercial da NF como vNF menos frete, outras despesas e
  seguro; IPI permanece. O pacote novo preserva componentes, mas suas telas
  usam `fact_sales.amount`. A migration `0021` registra a escolha por empresa em
  `companies.revenue_basis`: DEMO permanece `goods`, e empresas reais migradas
  recebem explicitamente `commercial_base`. O cabeçalho preserva a base legada
  pré-calculada (`commercial_base_amount`) ou aplica a fórmula aos componentes.
  Para filtros de produto/categoria, a base é distribuída proporcionalmente aos
  valores originais dos itens, com arredondamento de centavos e resíduo no último
  item. O universo de rateio é a NF inteira, antes desses filtros; os valores
  fiscais dos itens permanecem intactos. Base não zero com soma de itens zero
  bloqueia prontidão e produz erro explícito em vez de um faturamento falso.
- Status fiscal precisa de evidência de autorização. RAW de resposta ambígua
  deve permanecer para revisão; não transformar ausência de status em autorização.
- Preservar canal varejo/licitação, operação comercial/remessa, exclusões e
  visibilidade. O V2 não tem equivalência integral aos overrides por empresa e
  listas de vendedores do legado. Conceder o menor escopo enquanto esse mapa é
  validado; não converter automaticamente papéis limitados em papéis globais.
  `0024` conserva canais em `private.legacy_company_access`, com políticas
  restritivas e checagens nas funções financeiras privilegiadas. `0026` aplica a
  mesma restrição aos fatos Canonical. Canais desconhecidos não ganham acesso
  por inferência.
- Somente eventos reais de pagamento suportam fluxo e inadimplência histórica.
  Um saldo acumulado não deve ser convertido em várias baixas inventadas.
- Metas em vários níveis além dos três níveis do V2, agenda, cobrança, geografia,
  enriquecimentos e inteligência do legado precisam de preservação em área
  separada/extensões até existir destino equivalente.

## Backup e restauração

Guardar o dump final do MariaDB e o release anterior antes da troca. Fazer
`pg_dump -Fc` do banco novo, incluindo schemas `public`, `private` e `auth`; salvar
separadamente configurações e segredos. Restaurar em outro banco e executar
`verify_security.sql` antes de considerar o backup validado. O ledger deste deploy
é `private.vps_schema_migrations`, não um journal Drizzle presumido.

O pacote não contém a service-role key do projeto Supabase anterior. URLs e
chaves públicas do ZIP não autorizam migrations ou administração naquele projeto;
não utilizá-lo como banco novo nem reaproveitar dados de terceiros implicitamente.

## Nomes de usuário legados

`0023` cria `private.legacy_user_aliases` com chave normalizada em minúsculas e
`is_active`. Somente a função `resolve_legacy_login` (service-role) consulta o
e-mail no Auth; não existe diretório público de aliases/e-mails. O servidor de
login usa essa resolução internamente e retorna mensagens genéricas. Contas
legadas sem e-mail podem ter identificador técnico somente no Auth, mantendo o
perfil público sem um e-mail inventado. Preservar hash de senha pela API
administrativa suportada, verificar o resultado sem imprimir hashes e manter
contas inativas bloqueadas também no Auth.

## Regras e administração

`private.legacy_classification_config.settings` guarda as regras próprias e
classificações homologadas da empresa. O único leitor da aplicação é o RPC
service-role `get_legacy_classification_config`; documentos originais exigidos
por regras permanecem no servidor. Não registrar o JSON em logs ou respostas
do navegador. O sync aplica essa classificação antes do Canônico, mantendo sem
evidência como `unconfirmed`.

Os papéis atuais do V2 são globais. `0027` restringe mudanças desses papéis a
SUPER_ADMIN e impede ADMIN de conceder a si acesso a outra empresa. Um papel
administrativo parcial do legado não equivale à administração global do V2.

Validação adicional, após todas as migrations:

```sh
psql -v ON_ERROR_STOP=1 -f deploy/db/verify_legacy_access.sql
psql -v ON_ERROR_STOP=1 -f deploy/db/verify_order_scope.sql
```

O teste cria usuário Auth e fatos sintéticos em uma transação com ROLLBACK;
valida RLS e RPCs SECURITY DEFINER com autorização para um único canal.
O segundo teste confirma que orçamentos (etapa 10), remessas e classificações
desconhecidas não entram na carteira/forecast, e que a promoção Gold acompanha
mudanças de etapa sem apagar o histórico operacional.
