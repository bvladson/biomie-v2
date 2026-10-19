// Post-deploy browser smoke test. Credentials come ONLY from the environment
// (BIOMIE_SMOKE_ACCOUNTS, set in memory by ops/29_smoke.py) and are never written.
// Output: JSON with per-account results (no secrets).
const { chromium } = require('playwright');
const path = require('node:path');

const base = process.env.BIOMIE_TEST_URL || 'https://biomie.magmoveiscorporativos.com.br';
const accounts = JSON.parse(process.env.BIOMIE_SMOKE_ACCOUNTS || '[]');
const shots = process.env.BIOMIE_SMOKE_SHOTS || path.resolve(__dirname, '../../ops/logs');
const ROUTES = ['/plano-de-voo', '/vendas', '/vendedores', '/clientes', '/produtos', '/financeiro',
  '/qualidade-dos-dados', '/integracoes', '/admin'];

async function login(page, account) {
  await page.goto(base + '/auth');
  await page.getByRole('button', { name: 'Entrar', exact: true }).waitFor();
  await page.waitForTimeout(1500);
  await page.getByLabel('E-mail ou usuário').fill(account.email);
  await page.getByLabel('Senha', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL('**/cockpit**', { timeout: 60000 });
  await page.getByRole('heading', { name: 'Visão Geral', exact: true }).waitFor({ timeout: 60000 });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  for (const account of accounts) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    // Pre-cutover: open the public origin but serve pages from the private v2 web
    // (SSH tunnel); /supabase/ keeps going to the public API.
    const upstream = process.env.BIOMIE_TEST_UPSTREAM;
    if (upstream) {
      await page.route(base + '/**', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/supabase/')) return route.continue();
        const headers = { ...route.request().headers() };
        if (headers.origin) headers.origin = upstream;
        if (headers.referer) headers.referer = headers.referer.replace(base, upstream);
        delete headers.host;
        const response = await route.fetch({ url: upstream + url.pathname + url.search, headers });
        await route.fulfill({ response });
      });
    }
    const errors = [], serverFailures = [], csp = [], visited = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
    page.on('console', (m) => {
      const text = m.text();
      if (/Content Security Policy|Refused to/i.test(text)) csp.push(text.slice(0, 200));
      else if (m.type() === 'error') errors.push(text.slice(0, 200));
    });
    page.on('response', (r) => { if (r.status() >= 500) serverFailures.push({ path: new URL(r.url()).pathname, status: r.status() }); });
    const result = { account: account.label, login: false, routes: visited, relogin: false };
    try {
      await login(page, account);
      result.login = true;
      await page.waitForTimeout(2500);
      result.cockpitRevenue = (await page.locator('text=Faturamento').first().locator('xpath=../..').innerText()).replace(/\s+/g, ' ').slice(0, 80);
      result.coverageBanner = await page.getByRole('status').filter({ hasText: 'importado' }).count();
      await page.screenshot({ path: path.join(shots, `smoke-${account.label}-cockpit.png`), fullPage: true });
      for (const route of ROUTES) {
        await page.goto(base + route);
        await page.locator('h1, h2').first().waitFor({ timeout: 30000 });
        await page.waitForTimeout(800);
        const heading = (await page.locator('h1, h2').first().innerText()).slice(0, 80);
        visited.push({ route, heading, url: new URL(page.url()).pathname });
      }
      await page.goto(base + '/cockpit');
      await page.getByRole('heading', { name: 'Visão Geral', exact: true }).waitFor();
      await page.getByText(account.fullName, { exact: true }).first().click();
      await page.getByRole('menuitem', { name: 'Sair' }).click();
      await page.waitForURL('**/auth**', { timeout: 30000 });
      await login(page, account);
      result.relogin = true;
    } catch (e) {
      result.failure = e.message.slice(0, 300);
      await page.screenshot({ path: path.join(shots, `smoke-${account.label}-failure.png`), fullPage: true }).catch(() => {});
    }
    result.errors = errors;
    result.serverFailures = serverFailures;
    result.cspViolations = csp;
    results.push(result);
    await context.close();
  }
  await browser.close();
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => !r.login || !r.relogin || r.failure || r.serverFailures.length || r.cspViolations.length))
    process.exitCode = 1;
})();
