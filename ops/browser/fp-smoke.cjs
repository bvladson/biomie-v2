// Plano de Voo (migração 0050): as seis abas com Super admin, Diretoria, Gestor e Vendedor, tempo de carga
// de cada aba, erros na tela e no console, celular. Com BIOMIE_FP_WRITE=1 (só na HOMOLOGAÇÃO, a cópia é
// descartável) também grava: meta da empresa do mês seguinte, iniciativa com vendedor como responsável,
// alerta "Ciente" e decisão da reunião semanal, e confere o histórico.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const base = process.env.BIOMIE_TEST_URL || 'https://biomie.magmoveiscorporativos.com.br';
const accounts = JSON.parse(process.env.BIOMIE_SMOKE_ACCOUNTS || '[]');
const shots = process.env.BIOMIE_SMOKE_SHOTS || path.resolve(__dirname, '../../ops/logs');
const stamp = process.env.BIOMIE_SMOKE_STAMP || String(Date.now());
const WRITE = process.env.BIOMIE_FP_WRITE === '1';
// Ensaio local (harness com o simulador): sem login, a pessoa vem do endereço (?as=).
const HARNESS = process.env.BIOMIE_FP_HARNESS === '1';
const url = (account, p) => {
  if (!HARNESS) return base + p;
  const sep = p.includes('?') ? '&' : '?';
  return `${base}${p}${sep}as=${account.role === 'SUPER_ADMIN' ? 'ADMIN' : account.role}`;
};
const TABS = [['visao', 'Visão geral'], ['destino', 'Destino'], ['rota', 'Rota'], ['velocidade', 'Velocidade'],
  ['painel', 'Painel'], ['correcao', 'Correção de rota']];
const BUSY = /Carregando|Calculando|Montando|calculando|Gerando|Preparando/;
const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const redact = (text) => String(text)
  .replace(/(authorization|cookie|apikey|x-api-key)\s*:\s*[^\n']+/gi, '$1: [redacted]')
  .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
  .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[jwt]');

async function shot(page, account, name) {
  await page.screenshot({ path: path.join(shots, `fp-${stamp}-${account.label}-${name}.png`), fullPage: true }).catch(() => {});
}
async function login(page, account) {
  await page.goto(base + '/auth');
  await page.getByRole('button', { name: 'Entrar', exact: true }).waitFor();
  await page.waitForTimeout(1500);
  await page.getByLabel('E-mail ou usuário').fill(account.email);
  await page.getByLabel('Senha', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL('**/cockpit**', { timeout: 60000 });
}
/** Espera a aba terminar de carregar; devolve ms e se ficou em estado de erro. */
async function ready(page, started) {
  const deadline = Date.now() + 60000;
  for (;;) {
    const text = await page.locator('#fp-main').innerText().catch(() => '');
    if (text && !BUSY.test(text)) break;
    if (Date.now() > deadline) return { ms: Date.now() - started, timeout: true };
    await page.waitForTimeout(150);
  }
  const ms = Date.now() - started;
  const error = await page.getByRole('button', { name: 'Tentar novamente' }).count();
  return { ms, error: error > 0 };
}
async function toast(page) {
  await page.waitForTimeout(800);
  return (await page.locator('[data-sonner-toast]').allInnerTexts()).map(clean);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  for (const account of accounts) {
    const out = { label: account.label, role: account.role, tabs: {}, pageErrors: [], consoleErrors: [] };
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'pt-BR', acceptDownloads: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => out.pageErrors.push(redact(e.message).slice(0, 300)));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/favicon|Failed to load resource: the server responded with a status of 40[13]/.test(m.text()))
        out.consoleErrors.push(redact(m.text()).slice(0, 300));
    });
    try {
      if (!HARNESS) await login(page, account);
      let t0 = Date.now();
      await page.goto(url(account, '/plano-de-voo'));
      await page.getByRole('heading', { name: 'Plano de Voo Comercial' }).waitFor({ timeout: 60000 });
      out.tabs.visao = { ...(await ready(page, t0)), firstLoad: true };
      out.header = clean(await page.locator('header').filter({ hasText: 'Plano de Voo Comercial' }).first().innerText());
      out.tabs.visao.sample = clean(await page.locator('#fp-main').innerText()).slice(0, 220);
      await shot(page, account, 'visao');
      for (const [key, name] of TABS.slice(1)) {
        t0 = Date.now();
        await page.getByRole('navigation', { name: 'Pilares do Plano de Voo' }).getByRole('link', { name, exact: true }).click();
        out.tabs[key] = await ready(page, t0);
        out.tabs[key].sample = clean(await page.locator('#fp-main').innerText()).slice(0, 220);
        await shot(page, account, key);
      }
      // Volta para a Visão geral: dado em cache (deve ser imediato).
      t0 = Date.now();
      await page.getByRole('navigation', { name: 'Pilares do Plano de Voo' }).getByRole('link', { name: 'Visão geral', exact: true }).click();
      out.tabs.visaoDeNovo = await ready(page, t0);

      if (WRITE && account.label === 'diretoria') {
        const w = {};
        const next = (() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 7); })();
        await page.goto(url(account, '/plano-de-voo/destino?period=' + next));
        await ready(page, Date.now());
        await page.getByLabel('Meta Ativa Varejo').fill('350.000');
        await page.getByRole('button', { name: 'Salvar metas' }).click();
        await page.getByText('Confirmar lote de metas').waitFor({ timeout: 30000 });
        w.dialog = clean(await page.getByRole('alertdialog').innerText()).slice(0, 200);
        await page.getByRole('button', { name: 'Confirmar e gravar' }).click();
        w.targetToast = await toast(page);
        await page.getByRole('navigation', { name: 'Pilares do Plano de Voo' }).getByRole('link', { name: 'Visão geral', exact: true }).click();
        await ready(page, Date.now());
        w.overviewNextMonth = clean(await page.locator('#fp-main').innerText()).slice(0, 200);
        await page.goto(url(account, '/plano-de-voo/rota'));
        await ready(page, Date.now());
        await page.getByRole('button', { name: 'Nova iniciativa' }).click();
        await page.locator('#in-title').fill(`Teste da homologação ${stamp}`);
        await page.locator('#in-lever').click();
        await page.getByRole('option', { name: 'Reativar clientes' }).click();
        await page.locator('#in-owner').click();
        const owners = await page.getByRole('option').allInnerTexts();
        w.ownerOptions = owners.length;
        await page.getByRole('option').nth(Math.min(1, owners.length - 1)).click();
        const due = new Date(); due.setUTCDate(due.getUTCDate() + 7);
        await page.locator('#in-due').fill(due.toISOString().slice(0, 10));
        await page.locator('#in-amount').fill('10.000');
        await page.getByRole('button', { name: 'Salvar', exact: true }).click();
        w.initiativeToast = await toast(page);
        await page.goto(url(account, '/plano-de-voo/correcao'));
        await ready(page, Date.now());
        const ack = page.locator('li', { has: page.getByRole('button', { name: 'Ciente' }) }).first();
        if (await ack.count()) {
          await ack.getByRole('button', { name: 'Ciente' }).click();
          await page.locator('#ack-note').fill('Teste da homologação');
          await page.getByRole('button', { name: 'Confirmar' }).click();
          w.alertToast = await toast(page);
        } else w.alertToast = ['nenhum alerta aberto'];
        await page.getByRole('tab', { name: 'Reunião semanal' }).click();
        await ready(page, Date.now());
        await page.locator('#dec-text').fill(`Decisão de teste ${stamp}`);
        await page.getByRole('button', { name: 'Registrar decisão' }).click();
        w.decisionToast = await toast(page);
        await page.goto(url(account, '/plano-de-voo/destino?period=' + next));
        await ready(page, Date.now());
        await page.getByRole('button', { name: /Histórico/ }).first().click();
        await page.waitForTimeout(2500);
        w.history = clean(await page.locator('[data-state="open"]').filter({ hasText: /Meta|Nenhuma/ }).first().innerText().catch(() => '')).slice(0, 240);
        out.writes = w;
      }
      if (account.label === 'super') {
        const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'pt-BR', isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
        const mp = await mob.newPage();
        out.mobile = {};
        for (const [key] of TABS) {
          await mp.goto(url(account, '/plano-de-voo' + (key === 'visao' ? '' : '/' + key)));
          await ready(mp, Date.now());
          out.mobile[key] = await mp.evaluate(() => document.documentElement.scrollWidth);
        }
        await mob.close();
      }
    } catch (e) {
      out.fatal = redact(e.message).slice(0, 600);
      await shot(page, account, 'falha');
    }
    out.ok = !out.fatal && !out.pageErrors.length && !out.consoleErrors.length &&
      Object.values(out.tabs).every((t) => !t.timeout && !t.error);
    await ctx.close();
    results.push(out);
  }
  await browser.close();
  const ok = results.every((r) => r.ok) && results.every((r) => !r.mobile || Object.values(r.mobile).every((w) => w <= 390));
  const steps = results.map((r) => ({ name: r.label, ok: r.ok, error: r.fatal || null }));
  const problems = results.flatMap((r) => [
    ...(r.fatal ? [`${r.label}: ${r.fatal}`] : []),
    ...r.pageErrors.map((e) => `${r.label}: erro na página: ${e}`),
    ...r.consoleErrors.map((e) => `${r.label}: console: ${e}`),
    ...Object.entries(r.tabs).filter(([, x]) => x.timeout || x.error).map(([k]) => `${r.label}: aba ${k} com erro ou sem carregar`),
    ...Object.entries(r.mobile || {}).filter(([, w]) => w > 390).map(([k, w]) => `${r.label}: aba ${k} vaza no celular (${w}px)`),
  ]);
  console.log(JSON.stringify({ ok, write: WRITE, steps, problems, results }, null, 1));
  process.exitCode = ok ? 0 : 1;
})();
