// Local, throwaway check of the DB suites in PGlite (Postgres 18 in WASM). Not the official gate:
// the official run is ops/22_test_database.py on the server (Postgres 17, real auth schema).
// Usage: node run_suites.mjs <source dir> [suite filter ...]
// Also: each deploy/db/rollback/*.down.sql runs inside a rolled-back transaction, and for the 0046 one the
// restored sales_kpis definition is compared with a database built WITHOUT 0046 (= production today).
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setup } from './setup.mjs';

const src = process.argv[2];
const only = process.argv.slice(3);
const SUITES = ['deploy/db/verify_security.sql', 'deploy/db/verify_channel_filter.sql',
  'deploy/db/verify_pipeline_contract.sql', 'deploy/db/verify_rpc_grants.sql',
  'deploy/db/verify_order_scope.sql', 'deploy/db/verify_finance_adjustments.sql',
  'deploy/db/verify_admin_users.sql', 'deploy/db/verify_stock.sql', 'deploy/db/verify_stock_curves.sql', 'deploy/db/verify_stock_suppliers.sql',
  'deploy/db/verify_stock_intel.sql', 'deploy/db/verify_stock_intel_insights.sql', 'deploy/db/verify_stock_intel_commercial.sql', 'deploy/db/verify_sales_kpis.sql', 'deploy/db/verify_flight_plan_v2.sql', 'deploy/db/verify_fact_sales_equivalence.sql',
  'scripts/test-commercial-contract.sql', 'scripts/test-omie-matching.sql'];
const SIG = "'public.sales_kpis(uuid,date,date,uuid,uuid,uuid,text,text,text)'::regprocedure";
const strip = (t) => t.split(/\r?\n/).filter((l) => !l.startsWith('\\set ')).join('\n');
// 0051: as três funções (definição + permissões) e o índice, para comparar o retorno com o banco sem a 0051.
const DEFS51 = `select jsonb_build_object(
  'fns', (select jsonb_object_agg(p.oid::regprocedure::text, jsonb_build_array(md5(pg_get_functiondef(p.oid)), p.proacl::text))
          from pg_proc p where p.oid in ('public.fact_sales(uuid,date,date,uuid,uuid,uuid,text,text,text)'::regprocedure,
            'public.invoice_item_amounts(uuid,date,date)'::regprocedure,
            'public.flight_plan_v2_dataset(uuid,int,int,jsonb,text,uuid,date,uuid,uuid,text,text,text)'::regprocedure)),
  'index', to_regclass('public.invoices_company_customer_date_idx') is not null)::text v`;

const db = await PGlite.create({ extensions: { pgcrypto } });
await setup(db, src);

let failed = 0;
for (const suite of SUITES) {
  if (only.length && !only.some((o) => suite.includes(o))) continue;
  let text;
  try { text = readFileSync(path.join(src, suite), 'utf8'); } catch { console.log(`--   ${suite}: ausente`); continue; }
  const notices = [];
  const s0 = Date.now();
  try {
    await db.exec(strip(text), { onNotice: (n) => notices.push(n.message) });
    console.log(`OK   ${suite} (${Date.now() - s0} ms)`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${suite}: ${e.message}${e.where ? ' | ' + e.where.split('\n')[0] : ''}`);
    try { await db.exec('rollback'); } catch { /* sem transação aberta */ }
  }
  for (const n of notices.slice(-8)) console.log('     ' + n);
}

let downs = [];
try { downs = readdirSync(path.join(src, 'deploy/db/rollback')).filter((f) => f.endsWith('.down.sql')).sort(); } catch { /* none */ }
for (const name of downs) {
  const text = readFileSync(path.join(src, 'deploy/db/rollback', name), 'utf8');
  try {
    await db.exec('begin;');
    await db.exec(text);
    const after = (await db.query(`select md5(pg_get_functiondef(${SIG})) h, (select proacl::text from pg_proc where oid = ${SIG}) acl`)).rows[0];
    const after51 = name.startsWith('0051_') ? (await db.query(DEFS51)).rows[0].v : null;
    await db.exec('rollback;');
    if (name.startsWith('0051_')) {
      const prod = await PGlite.create({ extensions: { pgcrypto } });
      await setup(prod, src, ['0051_fact_sales_performance']);
      const before = (await prod.query(DEFS51)).rows[0].v;
      await prod.close();
      const same = before === after51;
      if (!same) failed++;
      console.log(`${same ? 'OK  ' : 'FAIL'} rollback ${name}: funções, permissões e índice ${same ? 'idênticos' : 'DIFERENTES'} aos de antes da 0051`);
      if (!same) console.log(`     antes ${before}\n     depois ${after51}`);
    } else if (name.startsWith('0046_')) {
      const prod = await PGlite.create({ extensions: { pgcrypto } });
      await setup(prod, src, ['0046_sales_kpis_fast']);
      const before = (await prod.query(`select md5(pg_get_functiondef(${SIG})) h, (select proacl::text from pg_proc where oid = ${SIG}) acl`)).rows[0];
      await prod.close();
      const same = before.h === after.h && before.acl === after.acl;
      if (!same) failed++;
      console.log(`${same ? 'OK  ' : 'FAIL'} rollback ${name}: definição ${same ? 'idêntica' : 'DIFERENTE'} à de antes da 0046 (${after.h})`);
    } else {
      console.log(`OK   rollback ${name}: roda sem erro`);
    }
  } catch (e) {
    failed++;
    console.log(`FAIL rollback ${name}: ${e.message}`);
    try { await db.exec('rollback'); } catch { /* nada aberto */ }
  }
}
await db.close();
process.exit(failed ? 3 : 0);
