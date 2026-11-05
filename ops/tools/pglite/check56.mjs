// Ensaio local do SQL de ops/56_plano_voo_check.py no banco de exemplo (mesmos dados do fp_dump.mjs).
// Uso: node check56.mjs <source> <ops/56_plano_voo_check.py>
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';
import { setup } from './setup.mjs';

const [src, script] = process.argv.slice(2);
const py = readFileSync(script, 'utf8');
const sql = py.slice(py.indexOf('SQL = r"""') + 10, py.indexOf('"""', py.indexOf('SQL = r"""') + 10));
const dump = readFileSync(new URL('./fp_dump.mjs', import.meta.url), 'utf8');
const seed = dump.slice(dump.indexOf('await db.exec(`') + 15, dump.indexOf('end $$;`);') + 7);

const db = await PGlite.create({ extensions: { pgcrypto } });
await setup(db, src);
const ID = { adm: '00000000-0000-4000-8000-0000000000a1', ges: '00000000-0000-4000-8000-0000000000a2',
  ven: '00000000-0000-4000-8000-0000000000a3', c: '00000000-0000-4000-8000-0000000000c1',
  s1: '00000000-0000-4000-8000-0000000000b1', s2: '00000000-0000-4000-8000-0000000000b2',
  s3: '00000000-0000-4000-8000-0000000000b3', sl: '00000000-0000-4000-8000-0000000000b4',
  // Perfis sem vínculo do fp_dump.mjs (Gestor sem equipe, Vendedor sem vínculo).
  ges2: '00000000-0000-4000-8000-0000000000a4', ven2: '00000000-0000-4000-8000-0000000000a5' };
const TODAY = '2026-11-18';
await db.exec(seed.replace(/\$\{ID\.(\w+)\}/g, (_, k) => ID[k]).replace(/\$\{TODAY\}/g, TODAY));
await db.exec(`insert into auth.users(id, email) values ('00000000-0000-4000-8000-0000000000a9', 'sa@invalid.example');
  insert into public.profiles(id) values ('00000000-0000-4000-8000-0000000000a9');
  insert into public.user_roles(user_id, role) values ('00000000-0000-4000-8000-0000000000a9', 'SUPER_ADMIN');`);
const res = await db.exec(sql);
const last = res.filter((r) => r.rows.length).at(-1).rows[0];
const lines = String(Object.values(last)[0]).split('\n');
for (const l of lines) console.log(l.slice(0, 900));
await db.close();
