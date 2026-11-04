"""Plano de Voo v2 (migração 0050): conferência e desempenho — SÓ LEITURA.

    python ops/remote.py ops/56_plano_voo_check.py [--db=biomie_v2_hml|biomie_v2] --esperar

Como um usuário logado (o Super admin mais antigo, mesmo caminho das telas), em cada empresa real, no mês
de hoje:
- leitura antiga (flight_plan_dataset) × nova (flight_plan_v2_dataset): faturamento do mês tem de ser
  IGUAL; vendedores, pedidos e orçamentos lado a lado; tempo de 3 chamadas de cada (fria e quentes);
- tempo das outras leituras novas: ano, listas de alvos e grade de metas;
- canal oficial do cadastro dos vendedores (nenhum vendedor de empresa real sem canal; 1 "Licitação");
- histórico de etapa dos pedidos (ponto de partida da conversão);
- limites de tempo (só casos patológicos, a tela ficaria inutilizável): leitura do mês (mediana) até 8 s,
  grade de metas até 8 s, ano e listas de alvos até 15 s.
Uma transação read only (statement_timeout 10 min, sem paralelismo). Sem nomes de pessoas na saída.
O padrão é a cópia da homologação (biomie_v2_hml); na produção, só depois da ativação e fora do expediente.
"""
import json
import pathlib
import subprocess
import sys

BASE = pathlib.Path('/opt/biomie-v2')
COMPOSE = ['docker', 'compose', '--env-file', str(BASE / 'shared/stack.env'), '-f', str(BASE / 'compose.yml')]
DB = next((a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--db=')), 'biomie_v2_hml')
if DB not in ('biomie_v2_hml', 'biomie_v2'):
    raise SystemExit('banco inválido')

SQL = r"""
begin read only;
set local statement_timeout = '600s';
set local max_parallel_workers_per_gather = 0;
select set_config('fp.channels', coalesce((select jsonb_agg(to_jsonb(x) order by x.slug, x.canal)::text from (
  select c.slug, coalesce(lower(ch.name), '(vazio)') canal, count(*) n,
    count(*) filter (where public.normalize_text(s.name) = 'licitacao') licitacao_por_nome
  from public.sellers s join public.companies c on c.id = s.company_id left join public.channels ch on ch.id = s.channel_id
  where not c.is_demo group by 1, 2) x), '[]'), true);
select set_config('fp.events', coalesce((select jsonb_build_object('linhas', count(*), 'pedidos', count(distinct order_id),
  'orcamentosNoInicio', count(*) filter (where to_stage = '10'))::text from private.sales_order_stage_events), '{}'), true);
select set_config('request.jwt.claims', json_build_object('sub', (select r.user_id from public.user_roles r
  join auth.users u on u.id = r.user_id where r.role = 'SUPER_ADMIN' and u.email not like 'smoke-%'
  order by u.created_at limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  c record; t0 timestamptz; old jsonb; new jsonb; out jsonb := '[]'; i int;
  ms_old numeric[]; ms_new numeric[]; ms_year numeric; ms_lists numeric; ms_targets numeric;
  today date; v_start date; v_pm date; v_py date; d int; y int; m int; win jsonb;
begin
  for c in select id, slug from public.companies where not is_demo order by slug loop
    today := public.data_as_of(c.id);
    v_start := date_trunc('month', today)::date;
    v_pm := (v_start - interval '1 month')::date;
    v_py := (v_start - interval '1 year')::date;
    d := extract(day from today)::int;
    y := extract(year from today)::int;
    m := extract(month from today)::int;
    -- Mesmas janelas de src/domain/comparison.ts para o mês aberto (mesmo dia de corte).
    win := jsonb_build_object(
      'previous', jsonb_build_object('start', v_pm, 'end', least(v_pm + (d - 1), v_start - 1)),
      'lastYear', jsonb_build_object('start', v_py, 'end', least(v_py + (d - 1), (v_py + interval '1 month - 1 day')::date)),
      'trailing3', jsonb_build_object('start', (v_start - interval '3 months')::date, 'end', v_start - 1, 'divisor', 3));
    ms_old := '{}';
    ms_new := '{}';
    for i in 1..3 loop
      t0 := clock_timestamp();
      old := public.flight_plan_dataset(c.id, y, m);
      ms_old := ms_old || round(extract(epoch from clock_timestamp() - t0) * 1000);
      t0 := clock_timestamp();
      new := public.flight_plan_v2_dataset(c.id, y, m, win);
      ms_new := ms_new || round(extract(epoch from clock_timestamp() - t0) * 1000);
    end loop;
    t0 := clock_timestamp();
    perform public.flight_plan_v2_year(c.id, y);
    ms_year := round(extract(epoch from clock_timestamp() - t0) * 1000);
    t0 := clock_timestamp();
    perform public.flight_plan_v2_target_lists(c.id);
    ms_lists := round(extract(epoch from clock_timestamp() - t0) * 1000);
    t0 := clock_timestamp();
    perform public.flight_plan_targets_month(c.id, y, m);
    ms_targets := round(extract(epoch from clock_timestamp() - t0) * 1000);
    out := out || jsonb_build_object(
      'slug', c.slug, 'today', today,
      'msOld', to_jsonb(ms_old), 'msNew', to_jsonb(ms_new),
      'msYear', ms_year, 'msLists', ms_lists, 'msTargets', ms_targets,
      'realizedOld', (select coalesce(round(sum(coalesce((e->>'revenue')::numeric, 0)), 2), 0) from jsonb_array_elements(old->'days') e),
      'realizedNew', (select coalesce(round(sum((e->>'amount')::numeric), 2), 0) from jsonb_array_elements(new->'daily') e),
      'sellersOld', jsonb_array_length(old->'sellers'), 'sellersNew', jsonb_array_length(new->'sellers'),
      'ordersOld', (select count(*) from jsonb_array_elements(old->'sellers') s, jsonb_array_elements(s->'orders') o),
      'ordersNew', jsonb_array_length(new->'orders'), 'quotesNew', jsonb_array_length(new->'quotes'),
      'unassignedNew', new->'totals'->'unassigned', 'newCustomers', new->'totals'->'newCustomers',
      'holidayYears', new->'holidayYears', 'conversion', new->'conversion',
      'companyTargets', jsonb_array_length(new->'companyTargets'), 'sellerTargetRows', jsonb_array_length(new->'sellerTargets'));
  end loop;
  perform set_config('fp.out', out::text, true);
end $$;
select current_setting('fp.channels') || chr(10) || current_setting('fp.events') || chr(10) || current_setting('fp.out');
commit;
"""

p = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', DB, '-At', '-v', 'ON_ERROR_STOP=1'],
                   input=SQL, capture_output=True, text=True, timeout=3600)
if p.returncode:
    raise SystemExit(p.stderr[-1500:])
lines = [x for x in p.stdout.splitlines() if x.startswith('[') or x.startswith('{')]
channels, events, companies = json.loads(lines[-3]), json.loads(lines[-2]), json.loads(lines[-1])
med = lambda xs: sorted(xs)[len(xs) // 2] if xs else None  # noqa: E731
for c in companies:
    c['realizedEqual'] = c['realizedOld'] == c['realizedNew']
    c['medianOldMs'], c['medianNewMs'] = med(c['msOld']), med(c['msNew'])
problems = [f"{c['slug']}: faturamento do mês difere ({c['realizedOld']} × {c['realizedNew']})"
            for c in companies if not c['realizedEqual']]
problems += [f"{x['slug']}: {x['n']} vendedor(es) sem canal" for x in channels if x['canal'] == '(vazio)']
LIMITS = {'medianNewMs': 8000, 'msTargets': 8000, 'msYear': 15000, 'msLists': 15000}
problems += [f"{c['slug']}: {k} = {c[k]} ms (limite {v} ms)" for c in companies for k, v in LIMITS.items()
             if (c.get(k) or 0) > v]
print(json.dumps({'database': DB, 'ok': not problems, 'problems': problems, 'companies': companies,
                  'sellerChannels': channels, 'stageEvents': events}, ensure_ascii=False, indent=1))
