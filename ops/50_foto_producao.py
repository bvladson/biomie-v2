"""Foto dos números da PRODUÇÃO (SÓ LEITURA), para antes e depois de uma ativação. Com o worker pausado, as
duas fotos têm de ser iguais: as migrações novas só criam objetos e trocam funções por versões com filtros
opcionais; nenhum número que já existe pode mudar.

    python ops/remote.py ops/50_foto_producao.py            # produção (leve; à noite, com o worker pausado)
    python ops/remote.py ops/50_foto_producao.py --copia    # a cópia da homologação, antes e depois das
                                                            # migrações (pesado: só na janela de testes)

Por empresa: leitura publicada e posições/unidades/valor a custo; curvas (produtos e faturamento por curva
e janela); faturamento (fact_sales) por mês fechado de 2026; sales_kpis do 3º trimestre e de 1º a 25 de
outubro (md5 do JSON inteiro); painel do Estoque (stock_overview, janela padrão, como o Super admin mais
antigo; md5 do JSON). Mais: migrações e versão (md5) do sales_kpis. Uma consulta por parte, cada uma numa
transação read only com limite de 120 s; nada é gravado; sem nomes nem e-mails na saída.
"""
import json
import subprocess
import sys
import time

DB = 'biomie_v2_hml' if '--copia' in sys.argv else 'biomie_v2'
# Partes com muitas chamadas (um fact_sales por mês e empresa; dez sales_kpis) podem levar mais.
TIMEOUTS = {'sales': '300s', 'kpis': '300s'}
COMPOSE = ['docker', 'compose', '--env-file', '/opt/biomie-v2/shared/stack.env', '-f', '/opt/biomie-v2/compose.yml']
AS_SUPER_ADMIN = ("select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', "
                  "(select r.user_id from public.user_roles r join auth.users u on u.id = r.user_id "
                  "where r.role = 'SUPER_ADMIN' and u.email not like 'smoke-%' order by u.created_at limit 1))::text, "
                  "true) is not null;")
PARTS = {
    'migrations': "select to_json(count(*) || ' / ' || max(name)) from private.vps_schema_migrations",
    'salesKpisMd5': "select to_json(md5(pg_get_functiondef("
                    "'public.sales_kpis(uuid,date,date,uuid,uuid,uuid,text,text,text)'::regprocedure)))",
    'readings': "select json_object_agg(c.slug, sc.reading_id) from private.stock_current sc "
                "join public.companies c on c.id = sc.company_id",
    'curveRuns': "select json_object_agg(c.slug, r.finished_at) from (select distinct on (company_id) company_id, "
                 "finished_at from private.stock_curve_runs where status = 'ok' order by company_id, finished_at desc) r "
                 "join public.companies c on c.id = r.company_id",
    'stock': "select json_object_agg(t.slug, t.v) from (select c.slug, json_build_object('positions', count(*), "
             "'units', sum(sp.physical_qty), 'cost', round(sum(sp.physical_qty * sp.unit_cost), 2)) v "
             "from private.stock_current sc join private.stock_positions sp on sp.reading_id = sc.reading_id "
             "join public.companies c on c.id = sc.company_id group by c.slug) t",
    'curves': "select json_object_agg(t.k, t.v) from (select c.slug || ':' || a.curve_window as k, "
              "json_object_agg(a.curve, json_build_object('products', a.n, 'revenue', a.rev) order by a.curve) as v "
              "from (select company_id, curve_window, curve, count(*) n, round(sum(revenue), 2) rev "
              "from private.stock_auto_curves group by 1, 2, 3) a "
              "join public.companies c on c.id = a.company_id group by c.slug, a.curve_window) t",
    'sales': "select json_object_agg(t.k, t.v) from (select c.slug || ':' || to_char(m.m, 'YYYY-MM') as k, "
             "json_build_object('amount', round(coalesce(sum(f.amount), 0), 2), 'units', coalesce(sum(f.qty), 0), "
             "'invoices', count(distinct f.invoice_id)) as v from public.companies c "
             "cross join generate_series(date '2026-01-01', date_trunc('month', current_date) - interval '1 month', "
             "interval '1 month') m(m) "
             "left join lateral public.fact_sales(c.id, m.m::date, (m.m + interval '1 month - 1 day')::date) f on true "
             "where not c.is_demo group by c.slug, m.m) t",
    'kpis': "select json_object_agg(c.slug || ':' || p.k, md5(public.sales_kpis(c.id, p.s, p.e)::text)) "
            "from public.companies c cross join (values ('t3', date '2026-07-01', date '2026-09-30'), "
            "('out1a25', date '2026-10-01', date '2026-10-25')) p(k, s, e) where not c.is_demo",
    # O painel novo só acrescenta a chave "supplier" (o filtro de fornecedor, nulo sem filtro): sai da conta.
    # "readings" também sai: a situação da leitura depende da hora (fica "desatualizada" com 6 h) e a leitura
    # publicada já está na parte "readings" acima.
    'overview': "select json_object_agg(x.k, md5((public.stock_overview(x.p)::jsonb - 'supplier' - 'readings')::text)) "
                "from (select c.slug k, c.id::text p from public.companies c where not c.is_demo "
                "union all select 'todas', 'all') x",
}

def statement(key, expr):
    """Uma parte da foto: transação read only, 120 s, como o Super admin; devolve a linha 'chave|json'."""
    return (f"begin read only;\nset local statement_timeout = '{TIMEOUTS.get(key, '120s')}';\n" + AS_SUPER_ADMIN
            + "\n" + f"select '{key}' || '|' || coalesce(({expr})::text, 'null');\ncommit;\n")


def main():
    started = time.time()
    out = {'database': DB, 'timing': {}}
    for key, expr in PARTS.items():
        t0 = time.time()
        p = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', DB, '-At',
                                      '-v', 'ON_ERROR_STOP=1'], input=statement(key, expr), capture_output=True,
                           text=True, timeout=400)
        out['timing'][key] = round(time.time() - t0, 1)
        line = next((x for x in p.stdout.splitlines() if x.startswith(key + '|')), None)
        if p.returncode or line is None:
            out[key] = {'error': (p.stderr or p.stdout)[-400:]}
            continue
        out[key] = json.loads(line.split('|', 1)[1])
    out['seconds'] = round(time.time() - started, 1)
    out['ok'] = not any(isinstance(v, dict) and set(v) == {'error'} for v in out.values())
    print(json.dumps(out, ensure_ascii=False, default=str))


if __name__ == '__main__':
    main()
