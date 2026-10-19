"""Run on the VPS through ops/remote.py, after the Omie seller catalog sync.

Only existing source users/company grants are considered. The script does not
grant roles, company access, channel access, or infer sellers from their names.
All original target rows are archived privately, including unsupported levels.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from decimal import Decimal, InvalidOperation
import datetime
import hashlib
import json
import os
import pathlib
import re
import subprocess
import uuid


BASE = pathlib.Path('/opt/biomie-v2')
SOURCE_TABLES = (
    'biomie_sales_targets_monthly',
    'biomie_sales_target_levels',
    'biomie_company_targets',
)
CENT = Decimal('0.01')
BROAD_ROLES = {'SUPER_ADMIN', 'ADMIN', 'DIRETORIA', 'FINANCEIRO', 'ANALISTA', 'VIEWER'}


def stable_id(kind, key):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'biomie-v2:legacy:' + kind + ':' + str(key)))


def text(value):
    return '' if value is None else str(value).strip()


def enabled(value):
    return value is True or str(value).strip().lower() in {'1', 'true', 'yes', 's'}


def money(value):
    try:
        result = Decimal(text(value))
    except (InvalidOperation, ValueError):
        raise ValueError('invalid_amount') from None
    if not result.is_finite() or result < 0 or result >= Decimal('1000000000000'):
        raise ValueError('invalid_amount')
    if result != result.quantize(CENT):
        raise ValueError('amount_precision')
    return result.quantize(CENT)


def period(value):
    candidate = text(value)
    if not re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])', candidate):
        raise ValueError('invalid_period')
    year, month = map(int, candidate.split('-'))
    if year < 1900 or year > 2200:
        raise ValueError('invalid_period')
    return year, month


def group_key(row):
    return text(row.get('company_id')), text(row.get('vendor_id')), text(row.get('year_month'))


def select_target_levels(monthly, level_rows):
    """Keep the effective commitment; select only adjacent real source amounts."""
    baseline = money(monthly.get('target_amount'))
    candidates = set()
    issues = []
    if level_rows:
        # Explicit rows, including their active flags, supersede the old JSON cache.
        for row in level_rows:
            if not enabled(row.get('active')):
                continue
            try:
                candidates.add(money(row.get('target_amount')))
            except ValueError as exc:
                issues.append(str(exc))
    else:
        raw_tiers = monthly.get('tiers_json')
        if raw_tiers:
            try:
                tiers = json.loads(raw_tiers) if isinstance(raw_tiers, str) else raw_tiers
                if not isinstance(tiers, list):
                    raise ValueError('unsupported_tiers_shape')
                for tier in tiers:
                    if isinstance(tier, dict):
                        if 'active' in tier and not enabled(tier['active']):
                            continue
                        tier = tier.get('target_amount', tier.get('amount', tier.get('value')))
                    candidates.add(money(tier))
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                issues.append(str(exc) if isinstance(exc, ValueError) and len(str(exc)) < 40 else 'invalid_tiers_json')
    result = {'ACTIVE': baseline}
    below = [x for x in candidates if x < baseline]
    above = [x for x in candidates if x > baseline]
    if below:
        result['BASE'] = max(below)
    if above:
        result['CHALLENGE'] = min(above)
    return {level: format(amount, '.2f') for level, amount in result.items()}, issues


def build_plan(legacy, maps, catalog):
    """Pure planning function: no database writes and no secret-bearing output."""
    issues = []

    def issue(code, **details):
        issues.append({'code': code, **details})

    company_map = {text(k): text(v) for k, v in maps.get('companies', {}).items()}
    user_map = {text(k): text(v) for k, v in maps.get('users', {}).items()}
    real_companies = {c['id'] for c in catalog['companies'] if not c['is_demo']}
    sellers = [s for s in catalog['sellers'] if s.get('source') in {'omie', 'legacy-v1'} and s.get('external_id') not in (None, '', '__unknown__')]
    seller_index = defaultdict(list)
    sellers_by_company = defaultdict(list)
    sellers_by_id = {}
    for seller in sellers:
        seller_index[(seller['company_id'], text(seller['external_id']))].append(seller)
        sellers_by_company[seller['company_id']].append(seller)
        sellers_by_id[seller['id']] = seller
    grouped_monthly = defaultdict(list)
    grouped_levels = defaultdict(list)
    for row in legacy.get(SOURCE_TABLES[0], []):
        grouped_monthly[group_key(row)].append(row)
    for row in legacy.get(SOURCE_TABLES[1], []):
        grouped_levels[group_key(row)].append(row)

    target_index = defaultdict(list)
    targets_by_id = {}
    for target in catalog['targets']:
        key = (target['company_id'], target.get('seller_id'), int(target['year']), int(target['month']), target['level'])
        target_index[key].append(target)
        targets_by_id[target['id']] = target
    targets = []
    existing_target_count = 0
    monthly_mapped = 0
    for key, rows in sorted(grouped_monthly.items()):
        company_legacy, vendor, ym = key
        detail = {'company_legacy_id': company_legacy, 'vendor_external_id': vendor, 'period': ym}
        if len(rows) != 1:
            issue('duplicate_monthly_key', **detail)
            continue
        row = rows[0]
        cid = company_map.get(company_legacy)
        if cid not in real_companies:
            issue('company_unmapped', **detail)
            continue
        if text(row.get('currency') or 'BRL').upper() != 'BRL':
            issue('unsupported_currency', **detail)
            continue
        matching = seller_index.get((cid, vendor), [])
        current_omie = [s for s in matching if s.get('source') == 'omie']
        matching = current_omie or [s for s in matching if s.get('source') == 'legacy-v1']
        if len(matching) != 1:
            issue('seller_not_in_catalog' if not matching else 'ambiguous_seller_external_id', **detail)
            continue
        try:
            year, month = period(ym)
            chosen, level_issues = select_target_levels(row, grouped_levels.get(key, []))
        except ValueError as exc:
            issue(str(exc), **detail)
            continue
        for code in level_issues:
            issue(code, **detail)
        seller = matching[0]
        monthly_mapped += 1
        for level, amount in chosen.items():
            tid = stable_id('sales-target', ':'.join([company_legacy, vendor, ym, level]))
            proposed = {'id': tid, 'company_id': cid, 'seller_id': seller['id'], 'channel_id': None,
                        'year': year, 'month': month, 'level': level, 'amount': amount, 'active': True}
            existing = targets_by_id.get(tid)
            natural = (cid, seller['id'], year, month, level)
            if any(x['id'] != tid for x in target_index.get(natural, [])):
                issue('target_natural_key_conflict', level=level, **detail)
                continue
            if existing:
                matches = all(existing.get(k) == proposed[k] for k in ('company_id', 'seller_id', 'channel_id', 'year', 'month', 'level', 'active'))
                matches = matches and money(existing['amount']) == money(amount)
                if not matches:
                    issue('target_changed_after_import', level=level, **detail)
                else:
                    existing_target_count += 1
                continue
            targets.append(proposed)
    for key in grouped_levels.keys() - grouped_monthly.keys():
        issue('levels_without_monthly', company_legacy_id=key[0], vendor_external_id=key[1], period=key[2])

    roles = defaultdict(set)
    for row in catalog['roles']:
        roles[row['user_id']].add(row['role'])
    access_now = {(x['user_id'], x['company_id']) for x in catalog['access']}
    channel_access_now = {(x['user_id'], x['company_id']): set(x['allowed_channels']) for x in catalog['channel_access']}
    source_users = {text(u['id']): u for u in legacy.get('biomie_users', [])}
    source_scopes = {(text(x['user_id']), text(x['company_id'])): x for x in legacy.get('biomie_user_seller_scope', [])}
    source_selected = defaultdict(set)
    for row in legacy.get('biomie_user_visible_sellers', []):
        source_selected[(text(row['user_id']), text(row['company_id']))].add(text(row.get('seller_id')))

    desired = defaultdict(set)
    confirmed_channels = {}
    manager_companies = set()
    for source_access in legacy.get('biomie_user_companies', []):
        old_uid, old_cid = text(source_access['user_id']), text(source_access['company_id'])
        uid, cid = user_map.get(old_uid), company_map.get(old_cid)
        if not uid or not cid or 'GESTOR' not in roles[uid]:
            continue
        if cid not in real_companies or not enabled(source_users.get(old_uid, {}).get('is_active')):
            continue
        if (uid, cid) not in access_now:
            issue('manager_company_access_missing', user_legacy_id=old_uid, company_legacy_id=old_cid)
            continue
        channels = set()
        if enabled(source_access.get('can_varejo')):
            channels.add('varejo')
        if enabled(source_access.get('can_licitacao')):
            channels.add('licitacao')
        # Missing private permission rows must never turn into an implicit all grant.
        channels &= channel_access_now.get((uid, cid), set())
        if not channels:
            issue('manager_no_confirmed_channels', user_legacy_id=old_uid, company_legacy_id=old_cid)
            continue
        scope = source_scopes.get((old_uid, old_cid), {})
        mode = text(scope.get('visibility_mode') or 'all').lower()
        if mode == 'all':
            allowed = {s['id'] for s in sellers_by_company[cid]}
        elif mode == 'selected':
            allowed = {s['id'] for s in sellers_by_company[cid] if text(s['external_id']) in source_selected[(old_uid, old_cid)]}
        elif mode == 'own':
            own_code = next((text(source_users[old_uid].get(k)) for k in ('seller_id', 'vendor_id', 'codigo_vendedor_omie') if text(source_users[old_uid].get(k))), '')
            allowed = {s['id'] for s in sellers_by_company[cid] if own_code and text(s['external_id']) == own_code}
            if not allowed:
                issue('own_seller_binding_unavailable', user_legacy_id=old_uid, company_legacy_id=old_cid)
        else:
            allowed = set()
            issue('unknown_seller_scope', user_legacy_id=old_uid, company_legacy_id=old_cid)
        if mode != 'all' and roles[uid] & BROAD_ROLES:
            issue('blocking_broad_role_with_restricted_sellers', user_legacy_id=old_uid, company_legacy_id=old_cid)
            continue
        desired[(uid, cid)] |= allowed
        confirmed_channels[(uid, cid)] = sorted(channels)
        manager_companies.add((uid, cid))

    teams_by_id = {x['id']: x for x in catalog['teams']}
    team_members = defaultdict(set)
    open_members = {}
    for row in catalog['members']:
        if row.get('valid_to') is None:
            team_members[row['team_id']].add(row['seller_id'])
            open_members[row['seller_id']] = row
    open_manager_pairs = {(x['team_id'], x['user_id']) for x in catalog['managers'] if x.get('valid_to') is None}
    manager_ids = {x['id'] for x in catalog['managers']}
    new_teams, new_members, new_managers = {}, {}, {}
    intended_pairs = set()
    for (uid, cid), allowed in sorted(desired.items()):
        for sid in sorted(allowed):
            seller = sellers_by_id[sid]
            current = open_members.get(sid)
            if current:
                team = teams_by_id[current['team_id']]
                if team['company_id'] != cid or not team['active'] or not team_members[team['id']] <= allowed:
                    issue('team_scope_conflict', user_id=uid, company_id=cid, seller_id=sid)
                    continue
                tid = team['id']
            else:
                tid = stable_id('seller-team', cid + ':' + text(seller['external_id']))
                existing = teams_by_id.get(tid)
                if existing and (existing['company_id'] != cid or not existing['active'] or team_members[tid] - allowed):
                    issue('team_scope_conflict', user_id=uid, company_id=cid, seller_id=sid)
                    continue
                if not existing:
                    name = 'Legado · vendedor ' + text(seller['external_id'])
                    if any(t['company_id'] == cid and t['name'] == name for t in catalog['teams']):
                        issue('team_name_conflict', company_id=cid, seller_id=sid)
                        continue
                    new_teams[tid] = {'id': tid, 'company_id': cid, 'name': name}
                mid = stable_id('seller-team-member', tid + ':' + sid)
                if any(m['id'] == mid for m in catalog['members']):
                    issue('closed_membership_requires_review', company_id=cid, seller_id=sid)
                    continue
                new_members[mid] = {'id': mid, 'team_id': tid, 'seller_id': sid}
            intended_pairs.add((tid, uid))
            if (tid, uid) in open_manager_pairs:
                continue
            gid = stable_id('seller-team-manager', tid + ':' + uid)
            if gid in manager_ids:
                issue('closed_manager_link_requires_review', user_id=uid, company_id=cid, team_id=tid)
                continue
            new_managers[gid] = {'id': gid, 'team_id': tid, 'user_id': uid, 'company_id': cid}

    close_managers = []
    for row in catalog['managers']:
        if row.get('valid_to') is not None:
            continue
        pair = row['team_id'], row['user_id']
        owned = row['id'] == stable_id('seller-team-manager', row['team_id'] + ':' + row['user_id'])
        team = teams_by_id[row['team_id']]
        if owned and pair not in intended_pairs:
            close_managers.append(row['id'])
        elif not owned and (row['user_id'], team['company_id']) in desired:
            allowed = desired[(row['user_id'], team['company_id'])]
            if not team_members[row['team_id']] <= allowed:
                issue('blocking_existing_manager_scope', user_id=row['user_id'], company_id=team['company_id'], team_id=row['team_id'])

    return {'targets': targets, 'teams': list(new_teams.values()), 'members': list(new_members.values()),
            'managers': list(new_managers.values()), 'close_managers': close_managers, 'issues': issues,
            'scope_checks': [{'user_id': uid, 'company_id': cid, 'seller_ids': sorted(ids),
                              'allowed_channels': confirmed_channels[(uid, cid)]}
                             for (uid, cid), ids in sorted(desired.items())],
            'monthly_mapped': monthly_mapped, 'targets_existing': existing_target_count,
            'manager_company_pairs': len(manager_companies)}


def literal(value):
    if value is None:
        return 'NULL'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def private_write(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        handle.write(content)
    os.chmod(path, 0o600)


def execute(query):
    cmd = ['docker', 'compose', '--env-file', str(BASE / 'shared/stack.env'), '-f', str(BASE / 'compose.yml'),
           'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'biomie_v2', '-v', 'ON_ERROR_STOP=1', '-qAt']
    result = subprocess.run(cmd, input="SET standard_conforming_strings=on;\n" + query,
                            capture_output=True, text=True, timeout=180)
    if result.returncode:
        private_write(BASE / 'shared/targets-teams-import-error.log', result.stdout + '\n' + result.stderr)
        raise RuntimeError('Import SQL failed; diagnostic retained privately on VPS')
    return result.stdout.strip()


def read_catalog():
    fields = {
        'companies': 'select id,is_demo from public.companies',
        'sellers': 'select id,company_id,source,external_id,active from public.sellers',
        'targets': 'select id,company_id,seller_id,channel_id,year,month,level,amount,active from public.sales_targets',
        'roles': 'select user_id,role from public.user_roles',
        'access': 'select user_id,company_id from public.user_company_access',
        'channel_access': 'select user_id,company_id,allowed_channels from private.legacy_company_access',
        'teams': 'select id,company_id,name,active from public.sales_teams',
        'members': 'select id,team_id,seller_id,valid_from,valid_to from public.sales_team_members',
        'managers': 'select id,team_id,user_id,valid_from,valid_to from public.sales_team_managers',
    }
    parts = [literal(key) + ",(select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) from (" + query + ') r)'
             for key, query in fields.items()]
    return json.loads(execute('select jsonb_build_object(' + ','.join(parts) + ');'))


def archive_sources(legacy, maps):
    tables = {name: legacy.get(name, []) for name in SOURCE_TABLES}
    encoded = json.dumps(tables, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    fingerprint = hashlib.sha256(encoded.encode()).hexdigest()
    key = 'legacy.targets.archive.' + fingerprint
    envelope = json.dumps({'version': 1, 'sha256': fingerprint, 'source_tables': tables}, ensure_ascii=False)
    statements = ['begin;', "select pg_advisory_xact_lock(hashtextextended('biomie.legacy.targets.archive',0));",
                  'insert into private.app_settings(key,value) values(' + literal(key) + ',' + literal(envelope) + ') on conflict(key) do nothing;']
    for old_company, cid in maps.get('companies', {}).items():
        owned = {name: [row for row in rows if text(row.get('company_id')) == text(old_company)] for name, rows in tables.items()}
        value = json.dumps({'archive_key': key, 'source_tables': owned, 'mapping_policy': 'ACTIVE=monthly; BASE=nearest lower active; CHALLENGE=nearest higher active'}, ensure_ascii=False)
        statements.append('update private.legacy_classification_config set settings=jsonb_set(settings,\'{legacy_targets}\',' +
                          literal(value) + '::jsonb,true),updated_at=now() where company_id=' + literal(cid) + ';')
    statements += ['commit;']
    execute('\n'.join(statements))
    return key, fingerprint, tables


def apply_plan(plan):
    statements = ['begin;', "select pg_advisory_xact_lock(hashtextextended('biomie.legacy.targets.teams',0));",
                  'lock table public.sales_targets,public.sales_teams,public.sales_team_members,public.sales_team_managers,public.user_roles,public.user_company_access,private.legacy_company_access in share row exclusive mode;',
                  'create temporary table target_team_import_counts(metric text,n integer) on commit drop;']

    def write_count(name, mutation):
        statements.append('with written as (' + mutation.rstrip(';') + ' returning id) insert into target_team_import_counts select ' + literal(name) + ',count(*) from written;')

    scopes = {(x['user_id'], x['company_id']): x for x in plan['scope_checks']}
    for scope in plan['scope_checks']:
        uid, cid = literal(scope['user_id']), literal(scope['company_id'])
        channels = 'ARRAY[' + ','.join(literal(x) for x in scope['allowed_channels']) + ']::text[]'
        statements.append("do $$ begin if not exists(select 1 from public.user_roles where user_id=" + uid + " and role='GESTOR') or not exists(select 1 from public.user_company_access where user_id=" + uid + ' and company_id=' + cid + ') or not exists(select 1 from private.legacy_company_access where user_id=' + uid + ' and company_id=' + cid + ' and ' + channels + " <@ allowed_channels) then raise exception 'Access changed while planning; rerun the importer'; end if; end $$;")
    for target in plan['targets']:
        cols = ('id', 'company_id', 'seller_id', 'channel_id', 'year', 'month', 'level', 'amount', 'active')
        # A concurrent manual target with the same logical key aborts, never doubles the goal.
        predicate = 'company_id=' + literal(target['company_id']) + ' and seller_id=' + literal(target['seller_id']) + ' and year=' + str(target['year']) + ' and month=' + str(target['month']) + ' and level=' + literal(target['level'])
        statements.append("do $$ begin if exists(select 1 from public.sales_targets where " + predicate + ' and id<>' + literal(target['id']) + ") then raise exception 'Concurrent target change; rerun the importer'; end if; end $$;")
        write_count('targets_added', 'insert into public.sales_targets(' + ','.join(cols) + ') values(' + ','.join(literal(target[c]) for c in cols) + ') on conflict(id) do nothing')
    for team in plan['teams']:
        write_count('teams_added', 'insert into public.sales_teams(id,company_id,name,active) values(' + ','.join(literal(team[k]) for k in ('id', 'company_id', 'name')) + ',true) on conflict(id) do nothing')
    for member in plan['members']:
        write_count('members_added', 'insert into public.sales_team_members(id,team_id,seller_id,valid_from) values(' + ','.join(literal(member[k]) for k in ('id', 'team_id', 'seller_id')) + ',current_date) on conflict(id) do nothing')
        statements.append("do $$ begin if not exists(select 1 from public.sales_team_members where seller_id=" + literal(member['seller_id']) + ' and team_id=' + literal(member['team_id']) + " and valid_to is null) then raise exception 'Membership changed; rerun the importer'; end if; end $$;")
    created_teams = {x['id']: x['company_id'] for x in plan['teams']}
    for manager in plan['managers']:
        # Resolve the expected company from the plan, not from a mutable user grant.
        cid = created_teams.get(manager['team_id']) or manager['company_id']
        scope = scopes[(manager['user_id'], cid)]
        sellers = 'ARRAY[' + ','.join(literal(x) for x in scope['seller_ids']) + ']::uuid[]'
        statements.append("do $$ begin if not exists(select 1 from public.sales_teams where id=" + literal(manager['team_id']) + ' and company_id=' + literal(cid) + ' and active) or exists(select 1 from public.sales_team_members where team_id=' + literal(manager['team_id']) + ' and valid_to is null and not seller_id=any(' + sellers + ")) then raise exception 'Team scope changed; rerun the importer'; end if; end $$;")
        write_count('manager_links_added', 'insert into public.sales_team_managers(id,team_id,user_id,valid_from) values(' + ','.join(literal(manager[k]) for k in ('id', 'team_id', 'user_id')) + ',current_date) on conflict(id) do nothing')
    for identifier in plan['close_managers']:
        write_count('manager_links_closed', 'update public.sales_team_managers set valid_to=greatest(valid_from,current_date) where id=' + literal(identifier) + ' and valid_to is null')
    counts_query = "select coalesce(jsonb_object_agg(metric,n),'{}'::jsonb) from (select metric,sum(n) n from target_team_import_counts group by metric) x"
    statements += ["insert into public.audit_log(actor_id,action,entity,payload) values(null,'legacy.targets_teams_import','migration',(" + counts_query + '));',
                   counts_query + ';', 'commit;']
    return json.loads(execute('\n'.join(statements)))


def main():
    legacy = json.loads((BASE / 'shared/legacy-export.json').read_text(encoding='utf-8'))
    maps = json.loads((BASE / 'shared/legacy-map.json').read_text(encoding='utf-8'))
    archive_key, fingerprint, tables = archive_sources(legacy, maps)
    catalog = read_catalog()
    plan = build_plan(legacy, maps, catalog)
    blocking = sum(x['code'].startswith('blocking_') for x in plan['issues'])
    applied = apply_plan(plan) if not blocking else {}
    report = {'archive_key': archive_key, 'source_sha256': fingerprint,
              'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'mapping_policy': 'ACTIVE=monthly; BASE=nearest lower active; CHALLENGE=nearest higher active',
              'plan': plan, 'applied': applied}
    private_write(BASE / 'shared/targets-teams-import-report.json', json.dumps(report, ensure_ascii=False, indent=2))
    summary = {'status': 'blocked' if blocking else 'completed',
               'monthly_rows_archived': len(tables[SOURCE_TABLES[0]]), 'level_rows_archived': len(tables[SOURCE_TABLES[1]]),
               'company_target_rows_archived': len(tables[SOURCE_TABLES[2]]),
               'monthly_rows_mapped': plan['monthly_mapped'], 'targets_added': applied.get('targets_added', 0),
               'targets_already_present': plan['targets_existing'], 'teams_added': applied.get('teams_added', 0),
               'members_added': applied.get('members_added', 0), 'manager_links_added': applied.get('manager_links_added', 0),
               'manager_links_closed': applied.get('manager_links_closed', 0), 'manager_company_pairs': plan['manager_company_pairs'],
               'issues_by_code': dict(Counter(x['code'] for x in plan['issues'])),
               'company_targets': 'archived only; no seller allocation inferred',
               'channel_policy': 'existing private grants and RLS unchanged; target source has no channel'}
    private_write(BASE / 'ops/targets-teams-summary.json', json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False))
    if blocking:
        raise RuntimeError('Existing permissions require review; detailed plan retained privately on VPS')


if __name__ == '__main__':
    main()
