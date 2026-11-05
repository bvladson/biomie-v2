// Teste LOCAL do SQL da ops/58_desfazer_0051.py (PGlite): estado → desfaz (retorno + linha da migração) →
// banco igual ao de antes da 0051 → reaplica a 0051 → estado novo de volta + suíte de equivalência.
// Uso: node test58.mjs <source> <58_desfazer_0051.py>
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setup } from './setup.mjs';

const [src, script] = process.argv.slice(2);
const TAG = '0051_fact_sales_performance';
const py = readFileSync(script, 'utf8');
const i0 = py.indexOf('STATE = f"""') + 'STATE = f"""'.length;
const STATE = py.slice(i0, py.indexOf('"""', i0)).replaceAll('{TAG}', TAG);
const DEFS = `select jsonb_build_object(
  'fns', (select jsonb_object_agg(p.oid::regprocedure::text, jsonb_build_array(md5(pg_get_functiondef(p.oid)), p.proacl::text))
          from pg_proc p where p.oid in ('public.fact_sales(uuid,date,date,uuid,uuid,uuid,text,text,text)'::regprocedure,
            'public.invoice_item_amounts(uuid,date,date)'::regprocedure,
            'public.flight_plan_v2_dataset(uuid,int,int,jsonb,text,uuid,date,uuid,uuid,text,text,text)'::regprocedure)),
  'index', to_regclass('public.invoices_company_customer_date_idx') is not null)::text v`;
const state = async (db) => (await db.query(STATE)).rows[0].json_build_object;
let failed = 0;
const check = (label, cond, detail) => { if (!cond) failed++; console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${cond ? '' : ' → ' + JSON.stringify(detail)}`); };

const db = await PGlite.create({ extensions: { pgcrypto } });
await setup(db, src);
const before = await state(db);
check('com a 0051: tudo novo presente', Object.values(before).every(Boolean), before);

const down = readFileSync(path.join(src, 'deploy/db/rollback', `${TAG}.down.sql`), 'utf8');
await db.exec('begin;');
await db.exec(down + `\ndelete from private.vps_schema_migrations where name like '${TAG}%';\n`);
await db.exec('commit;');
const after = await state(db);
check('depois do 58: nada da 0051 sobrou', !Object.values(after).some(Boolean), after);

const prod = await PGlite.create({ extensions: { pgcrypto } });
await setup(prod, src, [TAG]);
const want = (await prod.query(DEFS)).rows[0].v;
await prod.close();
const got = (await db.query(DEFS)).rows[0].v;
check('depois do 58: funções, permissões e índice iguais aos do banco sem a 0051', want === got, { want, got });

// A próxima ativação com a 0051 a aplica de novo (a linha foi apagada).
await db.exec(readFileSync(path.join(src, 'drizzle/migrations', `${TAG}.sql`), 'utf8'));
await db.exec(`insert into private.vps_schema_migrations(name, sha256) values ('${TAG}', 'reaplicada-no-teste');`);
const again = await state(db);
check('reaplicada: tudo novo de volta', Object.values(again).every(Boolean), again);
const strip = (t) => t.split(/\r?\n/).filter((l) => !l.startsWith('\\set ')).join('\n');
try {
  await db.exec(strip(readFileSync(path.join(src, 'deploy/db/verify_fact_sales_equivalence.sql'), 'utf8')));
  check('reaplicada: suíte de equivalência passa', true);
} catch (e) {
  check('reaplicada: suíte de equivalência passa', false, e.message);
}
await db.close();
process.exit(failed ? 3 : 0);
