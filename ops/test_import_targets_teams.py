"""Offline checks only: importing the ops script never executes its VPS main."""
import copy
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('targets_import', pathlib.Path(__file__).with_name('16_import_targets_teams.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

C, U, S1, S2 = [module.stable_id('test', key) for key in ('company', 'user', 'seller1', 'seller2')]


def fixture():
    legacy = {
        'biomie_sales_targets_monthly': [{'id': 1, 'company_id': 1, 'vendor_id': '10', 'year_month': '2026-03', 'target_amount': '100.00', 'currency': 'BRL', 'tiers_json': '[120,150]'}],
        'biomie_sales_target_levels': [dict(id=i, company_id=1, vendor_id='10', year_month='2026-03', target_amount=str(amount), active=1) for i, amount in enumerate([80, 100, 120, 150], 1)],
        'biomie_company_targets': [{'id': 1, 'company_id': 1, 'canal': 'varejo', 'competencia': '2026-03', 'meta_valor': '1000.00'}],
        'biomie_users': [{'id': 7, 'is_active': 1, 'role': 'manager'}],
        'biomie_user_companies': [{'user_id': 7, 'company_id': 1, 'can_varejo': 1, 'can_licitacao': 0}],
        'biomie_user_seller_scope': [], 'biomie_user_visible_sellers': [],
    }
    maps = {'companies': {'1': C}, 'users': {'7': U}}
    catalog = {'companies': [{'id': C, 'is_demo': False}],
               'sellers': [{'id': S1, 'company_id': C, 'source': 'omie', 'external_id': '10', 'active': True},
                           {'id': S2, 'company_id': C, 'source': 'omie', 'external_id': '20', 'active': False}],
               'targets': [], 'teams': [], 'members': [], 'managers': [],
               'roles': [{'user_id': U, 'role': 'GESTOR'}], 'access': [{'user_id': U, 'company_id': C}],
               'channel_access': [{'user_id': U, 'company_id': C, 'allowed_channels': ['varejo']}]}
    return legacy, maps, catalog


class TargetImportTests(unittest.TestCase):
    def test_commitment_and_adjacent_levels_preserve_source(self):
        legacy, maps, catalog = fixture()
        original = copy.deepcopy(legacy)
        plan = module.build_plan(legacy, maps, catalog)
        self.assertEqual({x['level']: x['amount'] for x in plan['targets']}, {'ACTIVE': '100.00', 'BASE': '80.00', 'CHALLENGE': '120.00'})
        self.assertEqual(legacy, original)
        self.assertTrue(all(x['channel_id'] is None for x in plan['targets']))

    def test_repeat_does_not_duplicate_targets_or_team_history(self):
        legacy, maps, catalog = fixture()
        first = module.build_plan(legacy, maps, catalog)
        catalog['targets'] = first['targets']
        catalog['teams'] = [{**row, 'active': True} for row in first['teams']]
        catalog['members'] = [{**row, 'valid_from': '2026-10-19', 'valid_to': None} for row in first['members']]
        catalog['managers'] = [{**row, 'valid_from': '2026-10-19', 'valid_to': None} for row in first['managers']]
        repeated = module.build_plan(legacy, maps, catalog)
        for key in ('targets', 'teams', 'members', 'managers', 'close_managers'):
            self.assertEqual(repeated[key], [])
        self.assertEqual(repeated['targets_existing'], 3)

    def test_private_channels_and_public_company_access_required(self):
        legacy, maps, catalog = fixture()
        catalog['channel_access'] = []
        plan = module.build_plan(legacy, maps, catalog)
        self.assertEqual(plan['managers'], [])
        self.assertIn('manager_no_confirmed_channels', {x['code'] for x in plan['issues']})
        catalog['access'] = []
        plan = module.build_plan(legacy, maps, catalog)
        self.assertEqual(plan['teams'], [])

    def test_selected_scope_does_not_expand_to_shared_team(self):
        legacy, maps, catalog = fixture()
        legacy['biomie_user_seller_scope'] = [{'user_id': 7, 'company_id': 1, 'visibility_mode': 'selected'}]
        legacy['biomie_user_visible_sellers'] = [{'user_id': 7, 'company_id': 1, 'seller_id': '10'}]
        team = module.stable_id('test', 'shared-team')
        catalog['teams'] = [{'id': team, 'company_id': C, 'name': 'Existing', 'active': True}]
        catalog['members'] = [{'id': str(i), 'team_id': team, 'seller_id': sid, 'valid_to': None} for i, sid in enumerate([S1, S2])]
        plan = module.build_plan(legacy, maps, catalog)
        self.assertEqual(plan['managers'], [])
        self.assertIn('team_scope_conflict', {x['code'] for x in plan['issues']})

    def test_own_without_binding_never_becomes_all(self):
        legacy, maps, catalog = fixture()
        legacy['biomie_user_seller_scope'] = [{'user_id': 7, 'company_id': 1, 'visibility_mode': 'own'}]
        plan = module.build_plan(legacy, maps, catalog)
        self.assertEqual(plan['managers'], [])
        self.assertIn('own_seller_binding_unavailable', {x['code'] for x in plan['issues']})

    def test_unmapped_vendor_and_user_edited_target_are_preserved(self):
        legacy, maps, catalog = fixture()
        first = module.build_plan(legacy, maps, catalog)
        changed = copy.deepcopy(first['targets'][0])
        changed['amount'] = '101.00'
        catalog['targets'] = [changed]
        plan = module.build_plan(legacy, maps, catalog)
        self.assertNotIn(changed['id'], {x['id'] for x in plan['targets']})
        self.assertIn('target_changed_after_import', {x['code'] for x in plan['issues']})
        catalog['sellers'] = []
        self.assertEqual(module.build_plan(legacy, maps, catalog)['targets'], [])

    def test_known_legacy_fallback_does_not_beat_omie_id(self):
        legacy, maps, catalog = fixture()
        fallback = {**catalog['sellers'][0], 'id': module.stable_id('test', 'fallback'), 'source': 'legacy-v1'}
        catalog['sellers'].append(fallback)
        plan = module.build_plan(legacy, maps, catalog)
        self.assertEqual({x['seller_id'] for x in plan['targets']}, {S1})
        catalog['sellers'] = [fallback]
        self.assertEqual({x['seller_id'] for x in module.build_plan(legacy, maps, catalog)['targets']}, {fallback['id']})

    def test_apply_sql_is_transactional_and_closes_without_delete(self):
        legacy, maps, catalog = fixture()
        plan = module.build_plan(legacy, maps, catalog)
        plan['close_managers'] = [module.stable_id('test', 'obsolete')]
        with patch.object(module, 'execute', return_value='{"targets_added":3}') as execute:
            self.assertEqual(module.apply_plan(plan)['targets_added'], 3)
        sql = execute.call_args.args[0]
        self.assertTrue(sql.startswith('begin;'))
        self.assertTrue(sql.endswith('commit;'))
        self.assertIn('valid_to=greatest(valid_from,current_date)', sql)
        self.assertNotIn('delete from', sql.lower())
        self.assertIn('target_team_import_counts', sql)


if __name__ == '__main__':
    unittest.main()
