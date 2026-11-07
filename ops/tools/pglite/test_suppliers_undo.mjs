// Teste LOCAL do SQL de `40_stock.py suppliers-undo` (PGlite, todas as migrações da release): importação simulada
// em duas empresas → ensaio (rollback) não muda nada → desfazer de UMA empresa apaga só o que é só do Omie e mantém
// prazos, fornecedor principal e vínculos manuais → repetir não faz nada → recusa com importação aberta, com a
// importação diária ligada e com empresa inexistente. Também lê a saída crua do psql (várias linhas: json_agg de
// linhas) com o psql_result do próprio script, que quebrou o 07a da validação de 06/11 quando lia uma linha só.
// Uso: node test_suppliers_undo.mjs <source> <40_stock.py>
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { setup } from './setup.mjs';

const [src, script] = process.argv.slice(2);
const render = (slug, confirm) => execFileSync('python', [script, 'suppliers-undo-sql', slug ?? '-', ...(confirm ? ['--confirmar'] : [])],
  { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
// O leitor da saída do psql (psql_result) do próprio 40_stock.py, sozinho (o resto do script roda na VPS).
const pyParse = (stdout) => execFileSync('python', ['-c', `
import ast, json, pathlib, sys
tree = ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'psql_result')
ns = {'json': json}
exec(compile(ast.Module(body=[fn], type_ignores=[]), 'psql_result', 'exec'), ns)
sys.stdout.write(json.dumps(ns['psql_result'](sys.stdin.read())))`, script],
  { input: stdout, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
let failed = 0;
const check = (label, cond, detail) => { if (!cond) failed++; console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${cond ? '' : ' → ' + JSON.stringify(detail)}`); };

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const JA = 'aaaaaaaa-0000-0000-0000-000000000001';
const JB = 'bbbbbbbb-0000-0000-0000-000000000001';

const db = await PGlite.create({ extensions: { pgcrypto } });
await setup(db, src);
await db.exec(`
  insert into public.companies(id, name, slug, data_source, revenue_basis) values
    ('${A}', 'Empresa A', 'empresa-a', 'OMIE_SHADOW', 'commercial_base'),
    ('${B}', 'Empresa B', 'empresa-b', 'OMIE_SHADOW', 'commercial_base');
  insert into private.stock_settings default values on conflict do nothing;
  update private.stock_settings set suppliers_enabled = false;
  insert into private.stock_supplier_jobs (id, company_id, trigger, status, finished_at) values
    ('${JA}', '${A}', 'ops', 'complete', now()), ('${JB}', '${B}', 'ops', 'complete', now());
  -- A: S1 só do Omie (sai); S2 com vínculo manual; S3 com prazo; S4 fornecedor principal; S5 só manual (fora).
  insert into private.stock_suppliers (company_id, supplier_id, omie_name, in_omie, job_id, seen_at) values
    ('${A}', '101', 'S1', true, '${JA}', now()), ('${A}', '102', 'S2', true, '${JA}', now()),
    ('${A}', '103', 'S3', true, '${JA}', now()), ('${A}', '104', 'S4', true, '${JA}', now()),
    ('${A}', '105', 'S5 manual', false, null, null),
    ('${B}', '201', 'B1', true, '${JB}', now());
  insert into private.stock_product_suppliers (company_id, omie_product_id, supplier_id, supplier_code, in_omie, manual, job_id) values
    ('${A}', '1', '101', 'c1', true, false, '${JA}'), ('${A}', '2', '101', 'c2', true, false, '${JA}'),
    ('${A}', '3', '102', 'c3', true, true, '${JA}'),  ('${A}', '4', '103', 'c4', true, false, '${JA}'),
    ('${A}', '5', '104', 'c5', true, false, '${JA}'), ('${A}', '6', '105', null, false, true, null),
    ('${B}', '9', '201', 'b9', true, false, '${JB}');
  insert into private.stock_lead_times (company_id, supplier_id, omie_product_id, lead_time_days, note) values
    ('${A}', '103', '', 30, 'prazo informado por Compras');
  insert into private.stock_preferred_suppliers (company_id, omie_product_id, supplier_id, note) values
    ('${A}', '5', '104', 'principal escolhido por Compras');
`);

const SNAP = `select json_build_object(
  'suppliers', (select json_agg(json_build_array(company_id = '${A}', supplier_id, in_omie) order by company_id, supplier_id) from private.stock_suppliers),
  'links', (select json_agg(json_build_array(company_id = '${A}', omie_product_id, supplier_id, in_omie, manual) order by company_id, omie_product_id) from private.stock_product_suppliers),
  'leadTimes', (select count(*) from private.stock_lead_times), 'preferred', (select count(*) from private.stock_preferred_suppliers),
  'audit', (select count(*) from public.audit_log where action = 'stock.suppliers.import_undone'))::text v`;
const snap = async () => JSON.parse((await db.query(SNAP)).rows[0].v);
const run = async (slug, confirm) => {
  const results = await db.exec(render(slug, confirm));
  const row = results.map((r) => r.rows?.[0]).find((r) => r && r.json_build_object);
  return row.json_build_object;
};
const refused = async (slug, text) => {
  try { await run(slug, true); return 'aceitou'; } catch (e) { await db.exec('rollback;'); return String(e.message).includes(text) ? true : e.message; }
};

// 1. Ensaio (rollback) nas duas empresas: números certos e nada muda.
const before = await snap();
const trial = await run(null, false);
const byCo = Object.fromEntries(trial.companies.map((c) => [c.company, c]));
check('ensaio: A apaga 4 vínculos só do Omie e mantém 1 manual', byCo['empresa-a'].linksDeleted === 4 && byCo['empresa-a'].linksManualKept === 1, byCo['empresa-a']);
check('ensaio: A apaga 1 fornecedor (S1) e mantém 3 (vínculo manual, prazo, principal)', byCo['empresa-a'].suppliersDeleted === 1 && byCo['empresa-a'].suppliersKept === 3, byCo['empresa-a']);
check('ensaio: nada do Omie sobra e dados das pessoas intactos (A e B)', trial.companies.every((c) => c.leftFromOmie === 0 && c.userDataIntact), trial.companies);
check('ensaio: cópia traz as linhas que sairiam', trial.backup.links.length === 6 && trial.backup.suppliers.length === 5, [trial.backup.links.length, trial.backup.suppliers.length]);
check('ensaio: banco igual depois (rollback)', JSON.stringify(await snap()) === JSON.stringify(before), await snap());

// 1b. Saída crua do psql -At (07a de 06/11): json sem conversão no PGlite = o texto que o psql imprime, linha a linha.
const rawResults = await db.exec(render(null, false), { parsers: { 114: (v) => v } });
const psqlOut = rawResults.filter((r) => r.rows?.length)
  .map((r) => r.rows.map((row) => r.fields.map((f) => row[f.name] ?? '').join('|')).join('\n') + '\n').join('');
check('psql: o resultado ocupa várias linhas (json_agg de linhas)', psqlOut.trim().split('\n').length > 1, psqlOut.slice(0, 300));
let oldFails = false;
try { JSON.parse([...psqlOut.split('\n')].reverse().find((l) => l.startsWith('{'))); } catch { oldFails = true; }
check('psql: o leitor antigo (uma linha só) quebra como no 07a', oldFails, null);
const parsed = JSON.parse(pyParse(psqlOut));
check('psql: psql_result junta as linhas e devolve o mesmo ensaio', JSON.stringify(parsed) === JSON.stringify(trial), parsed);
const LS = String.fromCharCode(0x2028);
const odd = JSON.parse(pyParse(`{"links" : [{"name":"S${LS}1"}, \n {"name":"S2"}]}\nROLLBACK\n`));
check('psql: separador de linha Unicode num nome e linha a mais no fim não atrapalham',
  odd.links.length === 2 && odd.links[0].name === `S${LS}1`, odd);
let emptyRefused = false;
try { pyParse('\n'); } catch (e) { emptyRefused = String(e.stderr || e.message).includes('sem resultado do banco'); }
check('psql: sem resultado → erro claro', emptyRefused, null);
check('psql: banco igual depois do ensaio cru (rollback)', JSON.stringify(await snap()) === JSON.stringify(before), await snap());

// 2. Desfazer só a empresa A.
const real = await run('empresa-a', true);
const after = await snap();
const supA = after.suppliers.filter((s) => s[0]).map((s) => `${s[1]}:${s[2]}`);
const linkA = after.links.filter((l) => l[0]).map((l) => `${l[1]}/${l[2]}:${l[3]}:${l[4]}`);
check('desfazer A: S1 saiu; S2, S3, S4 ficam sem a marca do Omie; S5 (manual) intacto',
  JSON.stringify(supA) === JSON.stringify(['102:false', '103:false', '104:false', '105:false']), supA);
check('desfazer A: só ficam os vínculos manuais (3/102 e 6/105), sem a marca do Omie',
  JSON.stringify(linkA) === JSON.stringify(['3/102:false:true', '6/105:false:true']), linkA);
check('desfazer A: prazo e fornecedor principal intactos', after.leadTimes === 1 && after.preferred === 1, after);
check('desfazer A: empresa B intocada', JSON.stringify(after.suppliers.filter((s) => !s[0])) === JSON.stringify([[false, '201', true]])
  && JSON.stringify(after.links.filter((l) => !l[0])) === JSON.stringify([[false, '9', '201', true, false]]), after);
check('desfazer A: 1 registro na Auditoria e resultado conferido', after.audit === before.audit + 1 && real.confirmed === true
  && real.companies.length === 1 && real.companies[0].userDataIntact && real.companies[0].leftFromOmie === 0, real.companies);

// 3. Repetir não faz nada.
const again = await run('empresa-a', true);
check('repetir em A: nada a apagar', again.companies[0].linksDeleted === 0 && again.companies[0].suppliersDeleted === 0
  && again.companies[0].suppliersKept === 0, again.companies[0]);

// 4. Recusas (nada muda).
const mid = await snap();
await db.exec(`insert into private.stock_supplier_jobs (company_id, trigger, status) values ('${B}', 'ops', 'queued');`);
check('recusa com importação aberta', await refused('empresa-b', 'em andamento ou na fila'), null);
await db.exec(`update private.stock_supplier_jobs set status = 'complete', finished_at = now() where company_id = '${B}' and status = 'queued';
  update private.stock_settings set suppliers_enabled = true;`);
check('recusa com a importação diária ligada', await refused('empresa-b', 'importação diária ligada'), null);
await db.exec('update private.stock_settings set suppliers_enabled = false;');
check('recusa com empresa inexistente', await refused('nao-existe', 'empresa não encontrada'), null);
const end = await snap();
check('recusas não mudaram nada', JSON.stringify({ ...end, audit: 0 }) === JSON.stringify({ ...mid, audit: 0 }) && end.audit === mid.audit, end);

await db.close();
console.log(failed ? `${failed} FALHA(S)` : 'tudo certo');
process.exit(failed ? 1 : 0);
