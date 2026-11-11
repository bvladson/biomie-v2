-- Desfaz a 0052_assistente_mag_ai: tira as funções do assistente, a tabela de metadados e a chave
-- ai_assistant; my_features() volta exatamente como na 0041.
-- A 0052 é só acréscimo: reativar a release anterior já basta para a tela; este arquivo limpa o banco.
-- Rodar com psql -1 (uma transação).

create or replace function public.my_features() returns text[]
language sql stable as $$ select stock_internal.features() $$;

drop function if exists public.ai_requests_summary(uuid, integer);
drop function if exists public.ai_request_rate(uuid, boolean);
drop function if exists public.ai_request_log(uuid, text, text, text, integer, integer, integer, integer, integer);
drop function if exists public.ai_assistant_set(boolean, text[]);
drop function if exists public.ai_assistant_enabled_for_me();
drop function if exists public.ai_assistant_config();

drop table if exists private.ai_requests;

delete from public.metric_config where metric_key = 'ai_assistant';
