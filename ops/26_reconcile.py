"""Reconciliation BIomie v2 x Omie (RAW) x BIomie antigo, per company and month.

    python ops/remote.py ops/26_reconcile.py [YYYY-MM-from] [YYYY-MM-to]

Read-only. Invoice differences are compared document by document (Omie id) and
categorized; the full report is stored root-only on the VPS; the printed summary
contains only counts and amounts.
"""
import collections
import datetime
import json
import os
import pathlib
import subprocess
import sys
from decimal import Decimal

BASE = pathlib.Path('/opt/biomie-v2')
COMPOSE = ['docker', 'compose', '--env-file', str(BASE / 'shared/stack.env'), '-f', str(BASE / 'compose.yml')]
M_FROM = sys.argv[1] if len(sys.argv) > 1 else '2026-01'
M_TO = sys.argv[2] if len(sys.argv) > 2 else datetime.date.today().strftime('%Y-%m')
LEGACY_SLUG = {'MAG_FILIAL': 'mag-filial', 'EXPERT': 'expert', 'UNI_DESIGN': 'uni-design',
               'MAG_MATRIZ': 'mag-matriz', 'ERGOOFFICE': 'ergooffice'}
D = Decimal


def pg(query):
    p = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', 'biomie_v2', '-At',
                                  '-v', 'ON_ERROR_STOP=1', '-c', 'begin read only; ' + query + ' commit;'],
                       capture_output=True, text=True, timeout=600)
    if p.returncode:
        raise SystemExit('postgres: ' + p.stderr[-800:])
    # json_agg separates elements with newlines: keep every line except the transaction markers.
    lines = [l for l in p.stdout.splitlines() if l not in ('BEGIN', 'COMMIT')]
    return json.loads('\n'.join(lines) or 'null')


def my(query):
    p = subprocess.run(['mariadb', '--batch', '--raw', 'biomie', '-e',
                        'SET SESSION TRANSACTION READ ONLY; ' + query], capture_output=True, text=True, timeout=600)
    if p.returncode:
        raise SystemExit('mariadb: ' + p.stderr[-800:])
    lines = p.stdout.splitlines()
    header = lines[0].split('\t')
    return [dict(zip(header, l.split('\t'))) for l in lines[1:]]


def num(v):
    return D('0') if v in (None, '', 'NULL') else D(str(v))


def month(d):
    return (d or '')[:7]


def in_window(m):
    return M_FROM <= m <= M_TO


# ---------- v2 ----------
v2_nf = pg("""select coalesce(json_agg(x), '[]') from (select c.slug, i.external_id id, i.number, i.status,
  to_char(i.competence_date,'YYYY-MM') m, i.operation_scope scope, i.business_channel ch, i.channel_reason reason,
  i.seller_external_id seller, i.commercial_base_amount::text base, i.gross_amount::text gross, i.missing_in_source missing
  from public.canonical_invoices i join public.companies c on c.id=i.company_id where not c.is_demo) x;""")
v2_raw = pg("""select coalesce(json_agg(x), '[]') from (select c.slug,
  to_char(to_date(r.payload->'ide'->>'dEmi','DD/MM/YYYY'),'YYYY-MM') m, count(*) n
  from public.raw_omie_invoices r join public.companies c on c.id=r.company_id where not c.is_demo group by 1,2) x;""")
v2_gold = pg("""select coalesce(json_agg(x), '[]') from (select c.slug, to_char(f.competence_date,'YYYY-MM') m,
  sum(f.amount)::text revenue, count(distinct f.invoice_id) nfs
  from public.companies c cross join lateral public.fact_sales(c.id,'2026-01-01','2026-12-31') f
  where not c.is_demo group by 1,2) x;""")
v2_orders = pg("""select coalesce(json_agg(x), '[]') from (select c.slug, to_char(o.order_date,'YYYY-MM') m, count(*) n,
  sum(o.total)::text total,
  count(*) filter (where o.operation_scope='commercial' and o.status='open' and o.stage_code is not null and o.stage_code<>'10') portfolio_n,
  coalesce(sum(o.total) filter (where o.operation_scope='commercial' and o.status='open' and o.stage_code is not null and o.stage_code<>'10'),0)::text portfolio,
  count(*) filter (where o.operation_scope in ('unconfirmed','unknown')) pending
  from public.canonical_orders o join public.companies c on c.id=o.company_id where not c.is_demo group by 1,2) x;""")
# Same basis as the legacy titles: by issue month, position today (paid = cash, open = balance).
v2_titles = pg("""select coalesce(json_agg(x), '[]') from (select c.slug, to_char(f.issue_date,'YYYY-MM') m, count(*) n,
  sum(f.original)::text total, sum(f.paid)::text paid, sum(f.open)::text open, sum(f.adjustments)::text adj,
  count(*) filter (where f.cancelled) cancelled
  from public.companies c cross join lateral public.finance_title_facts(c.id, current_date) f
  where not c.is_demo group by 1,2) x;""")
v2_settlements = pg("""select coalesce(json_agg(x), '[]') from (select c.slug, to_char(s.settlement_date,'YYYY-MM') m,
  count(*) n, sum(s.amount)::text total,
  count(*) filter (where not exists(select 1 from public.canonical_receivables r where r.company_id=s.company_id
    and r.external_id=s.receivable_external_id)) orphan
  from public.canonical_settlements s join public.companies c on c.id=s.company_id where not c.is_demo group by 1,2) x;""")
v2_open = pg("""select coalesce(json_agg(x), '[]') from (select c.slug, sum(f.open)::text open, count(*) filter (where f.open>0) n
  from public.companies c cross join lateral public.finance_title_facts(c.id, current_date) f where not c.is_demo group by 1) x;""")
v2_dims = pg("""select coalesce(json_agg(x), '[]') from (select c.slug,
  (select count(*) from public.sellers s where s.company_id=c.id and s.source='omie') sellers,
  (select count(*) from public.customers k where k.company_id=c.id and k.source='omie' and k.external_id<>'__unknown__') customers
  from public.companies c where not c.is_demo) x;""")

# ---------- legacy ----------
legacy_nf = my("""SELECT c.slug, n.nota_id_omie id, n.numero_nf number, n.status_fiscal status,
  DATE_FORMAT(n.data_emissao,'%Y-%m') m, n.operation_scope scope, n.business_channel ch, n.channel_confidence conf,
  n.channel_rule_id rule_id, n.codigo_vendedor_omie seller, n.channel_classified_at classified,
  COALESCE(n.valor_base_comercial_nf, n.valor_total - COALESCE(n.valor_frete,0) - COALESCE(n.valor_outras_despesas,0) - COALESCE(n.valor_seguro,0)) base,
  n.valor_base_comercial_nf base_stored
  FROM biomie_notas_fiscais_canonicas n JOIN biomie_companies c ON c.id=n.company_id""")
legacy_orders = my("""SELECT c.slug, DATE_FORMAT(p.data_emissao,'%Y-%m') m, COUNT(*) n, SUM(p.valor_total) total
  FROM biomie_pedidos_canonicos p JOIN biomie_companies c ON c.id=p.company_id GROUP BY 1,2""")
legacy_titles = my("""SELECT c.slug, DATE_FORMAT(t.data_emissao,'%Y-%m') m, COUNT(*) n, SUM(t.valor_liquido) total,
  SUM(t.valor_aberto) open, SUM(t.valor_pago) paid FROM biomie_titulos_financeiros_canonicos t
  JOIN biomie_companies c ON c.id=t.company_id GROUP BY 1,2""")
legacy_dims = my("""SELECT c.slug, (SELECT COUNT(*) FROM biomie_vendedores_omie v WHERE v.company_id=c.id) sellers,
  (SELECT COUNT(*) FROM biomie_clientes_dim k WHERE k.company_id=c.id) customers FROM biomie_companies c""")
exclusions = my("""SELECT company_id, entity_type, identifier_type, active, COUNT(*) n FROM biomie_data_exclusion_rules
  GROUP BY 1,2,3,4""")

companies = sorted(LEGACY_SLUG.values())
report = {'window': [M_FROM, M_TO], 'generated': datetime.datetime.now().isoformat(), 'companies': {}}
licitacao_codes = {r['slug']: set(r['codes'] or []) for r in pg(
    """select coalesce(json_agg(x),'[]') from (select c.slug, (s.settings->'licitacao_seller_codes') codes
    from private.legacy_classification_config s join public.companies c on c.id=s.company_id) x;""")}

for slug in companies:
    nf_v2 = {r['id']: r for r in v2_nf if r['slug'] == slug and in_window(r['m'])}
    nf_old = {r['id']: r for r in legacy_nf if LEGACY_SLUG.get(r['slug']) == slug and in_window(r['m']) and r['id'] not in ('', 'NULL')}
    months = sorted({r['m'] for r in nf_v2.values()} | {r['m'] for r in nf_old.values()})
    by_month = {}
    for m in months:
        v2 = [r for r in nf_v2.values() if r['m'] == m]
        old = [r for r in nf_old.values() if r['m'] == m]
        v2_auth = [r for r in v2 if r['status'] == 'authorized']
        old_auth = [r for r in old if r['status'] == 'autorizada']
        v2_comm = [r for r in v2_auth if r['scope'] == 'commercial' and r['ch'] in ('varejo', 'licitacao')]
        old_comm = [r for r in old_auth if r['scope'] == 'commercial' and r['ch'] in ('varejo', 'licitacao')]
        gold = next((g for g in v2_gold if g['slug'] == slug and g['m'] == m), {'revenue': '0', 'nfs': 0})
        raw = next((x['n'] for x in v2_raw if x['slug'] == slug and x['m'] == m), 0)
        by_month[m] = {
            'omie_raw_nfs': raw,
            'v2_nfs_all': len(v2), 'v2_nfs_authorized': len(v2_auth),
            'old_nfs_authorized': len(old_auth),
            'v2_commercial_nfs': len(v2_comm), 'old_commercial_nfs': len(old_comm),
            'v2_revenue': str(sum((num(r['base']) for r in v2_comm), D('0'))),
            'v2_gold_revenue': gold['revenue'], 'v2_gold_nfs': gold['nfs'],
            'old_revenue': str(sum((num(r['base']) for r in old_comm), D('0'))),
            'v2_varejo': str(sum((num(r['base']) for r in v2_comm if r['ch'] == 'varejo'), D('0'))),
            'v2_licitacao': str(sum((num(r['base']) for r in v2_comm if r['ch'] == 'licitacao'), D('0'))),
            'old_varejo': str(sum((num(r['base']) for r in old_comm if r['ch'] == 'varejo'), D('0'))),
            'old_licitacao': str(sum((num(r['base']) for r in old_comm if r['ch'] == 'licitacao'), D('0'))),
            'v2_pending_scope': sum(1 for r in v2_auth if r['scope'] in ('unconfirmed', 'unknown')),
        }
    # Document-level differences, categorized.
    cats = collections.defaultdict(lambda: {'n': 0, 'amount': D('0'), 'examples': []})

    def add(cat, amount, example):
        c = cats[cat]
        c['n'] += 1
        c['amount'] += amount
        if len(c['examples']) < 8:
            c['examples'].append(example)

    for nid, r in nf_v2.items():
        o = nf_old.get(nid)
        if r['status'] != 'authorized':
            # Authorized and counted by the legacy, not authorized/cancelled in Omie now.
            if o and o['status'] == 'autorizada' and o['scope'] == 'commercial' and o['ch'] in ('varejo', 'licitacao'):
                add('status_diff', -num(o['base']), {'nf': r['number'], 'm': r['m'], 'v2': r['status'], 'old': o['status']})
            continue
        v2_counts = r['scope'] == 'commercial' and r['ch'] in ('varejo', 'licitacao')
        if not o:
            if v2_counts:
                lic = r['seller'] in licitacao_codes.get(slug, set()) or r['reason'] in ('licitacao_seller_code', 'licitacao_seller_name')
                add('only_v2_licitacao' if lic else 'only_v2', num(r['base']), {'nf': r['number'], 'm': r['m'], 'ch': r['ch']})
            continue
        old_counts = o['status'] == 'autorizada' and o['scope'] == 'commercial' and o['ch'] in ('varejo', 'licitacao')
        if v2_counts != old_counts:
            if o['status'] != 'autorizada':
                add('status_diff', num(r['base']) if v2_counts else D('0'),
                    {'nf': r['number'], 'm': r['m'], 'v2': r['status'], 'old': o['status']})
            elif o['scope'] != r['scope']:
                add('scope_diff', num(r['base']) if v2_counts else -num(o['base']),
                    {'nf': r['number'], 'm': r['m'], 'v2': r['scope'], 'old': o['scope'], 'old_classified': o['classified'] not in ('', 'NULL')})
            else:
                add('channel_universe_diff', num(r['base']) if v2_counts else -num(o['base']),
                    {'nf': r['number'], 'm': r['m'], 'v2': r['ch'], 'old': o['ch']})
        elif v2_counts:
            if r['ch'] != o['ch']:
                add('channel_split_diff', num(r['base']),
                    {'nf': r['number'], 'm': r['m'], 'v2': r['ch'], 'v2_reason': r['reason'], 'old': o['ch'],
                     'old_rule': o['rule_id'], 'old_classified': o['classified'] not in ('', 'NULL')})
            delta = num(r['base']) - num(o['base'])
            if abs(delta) > D('0.01'):
                add('base_diff', delta, {'nf': r['number'], 'm': r['m'], 'v2': r['base'], 'old': str(o['base']),
                                        'old_stored': o['base_stored'] not in ('', 'NULL')})
    for nid, o in nf_old.items():
        if nid in nf_v2 or o['status'] != 'autorizada':
            continue
        if o['scope'] == 'commercial' and o['ch'] in ('varejo', 'licitacao'):
            add('only_old', num(o['base']), {'nf': o['number'], 'm': o['m'], 'ch': o['ch']})
    company = {
        'months': by_month,
        'document_differences': {k: {'n': v['n'], 'amount': str(v['amount']), 'examples': v['examples']} for k, v in cats.items()},
        'orders': {
            'v2': [x for x in v2_orders if x['slug'] == slug and in_window(x['m'])],
            'old': [x for x in legacy_orders if LEGACY_SLUG.get(x['slug']) == slug and in_window(x['m'])]},
        'titles': {
            'v2': [x for x in v2_titles if x['slug'] == slug and in_window(x['m'])],
            'old': [x for x in legacy_titles if LEGACY_SLUG.get(x['slug']) == slug and in_window(x['m'])]},
        'settlements_v2': [x for x in v2_settlements if x['slug'] == slug and in_window(x['m'])],
        'open_balance_v2': next((x for x in v2_open if x['slug'] == slug), None),
        'dimensions': {'v2': next((x for x in v2_dims if x['slug'] == slug), None),
                       'old': next((x for x in legacy_dims if LEGACY_SLUG.get(x['slug']) == slug), None)},
    }
    report['companies'][slug] = company
report['legacy_exclusion_rules'] = exclusions

out = BASE / 'ops' / f"reconciliation-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
out.write_text(json.dumps(report, ensure_ascii=False, indent=1, default=str))
os.chmod(out, 0o600)

# Printed summary: totals per company and month + difference categories (no names, no documents).
summary = {'report': str(out), 'window': report['window'], 'companies': {}}
for slug, c in report['companies'].items():
    months = c['months']
    summary['companies'][slug] = {
        'months': {m: [v['omie_raw_nfs'], v['v2_nfs_all'], v['v2_nfs_authorized'], v['old_nfs_authorized'],
                       v['v2_commercial_nfs'], v['old_commercial_nfs'], v['v2_revenue'], v['v2_gold_revenue'],
                       v['old_revenue'], v['v2_pending_scope']] for m, v in months.items()},
        'diffs': {k: [v['n'], v['amount']] for k, v in c['document_differences'].items()},
        'orders_v2_vs_old': [[x['m'], x['n'], x['total'], x['portfolio_n'], x['pending']] for x in c['orders']['v2']],
        'orders_old': [[x['m'], x['n'], x['total']] for x in c['orders']['old']],
        'titles_v2': [[x['m'], x['n'], x['total'], x['open'], x['paid'], x['adj'], x['cancelled']] for x in c['titles']['v2']],
        'titles_old': [[x['m'], x['n'], x['total'], x['open'], x['paid']] for x in c['titles']['old']],
        'settlements_v2': [[x['m'], x['n'], x['total'], x['orphan']] for x in c['settlements_v2']],
        'open_v2': c['open_balance_v2'], 'dims': c['dimensions'],
    }
summary['month_columns'] = ['omie_raw', 'v2_all', 'v2_auth', 'old_auth', 'v2_comm', 'old_comm', 'v2_rev',
                            'v2_gold_rev', 'old_rev', 'v2_pending']
print(json.dumps(summary, ensure_ascii=False, default=str))
