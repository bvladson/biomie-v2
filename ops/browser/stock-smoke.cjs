// Estoque (0041) no navegador, com contas de vida curta criadas por ops/29_smoke.py --stock.
// O resultado esperado depende da liberação (BIOMIE_STOCK_MODE = off | pilot | on):
//  - off: menu escondido para todos; o Super admin abre as telas pela URL; os demais veem o aviso.
//  - pilot: menu só para o Super admin.
//  - on: menu para todos com permissão; o vendedor vê quantidades, nunca custo nem simulação.
// Senhas só em memória; a saída é um JSON por etapa, sem segredos.
const { chromium } = require('playwright');

const base = process.env.BIOMIE_TEST_URL || 'https://biomie.magmoveiscorporativos.com.br';
const accounts = JSON.parse(process.env.BIOMIE_SMOKE_ACCOUNTS || '[]');
const mode = process.env.BIOMIE_STOCK_MODE || 'off';
const account = (label) => accounts.find((a) => a.label === label);
const redact = (text) => String(text)
  .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
  .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[jwt]');

const steps = [];
const problems = { errors: [], serverFailures: [], csp: [] };

async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    steps.push({ step: name, ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) });
  } catch (e) {
    steps.push({ step: name, ok: false, ms: Date.now() - started, error: redact(e.message).split('\n')[0].slice(0, 300) });
  }
}

async function open(browser, width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.errors.push(redact(e.message).slice(0, 200)));
  page.on('console', (m) => {
    const text = m.text();
    if (/Content Security Policy|Refused to/i.test(text)) problems.csp.push(redact(text).slice(0, 200));
    else if (m.type() === 'error') problems.errors.push(redact(text).slice(0, 200));
  });
  page.on('response', (r) => {
    if (r.status() >= 500) problems.serverFailures.push({ path: new URL(r.url()).pathname, status: r.status() });
  });
  return { context, page };
}

async function login(page, label) {
  const a = account(label);
  await page.goto(base + '/auth');
  await page.getByRole('button', { name: 'Entrar', exact: true }).waitFor();
  await page.getByLabel('E-mail ou usuário').fill(a.email);
  await page.getByLabel('Senha', { exact: true }).fill(a.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL('**/cockpit**', { timeout: 60000 });
}

const menuHasStock = (page) =>
  page.getByRole('link', { name: 'Estoque', exact: true }).count().then((n) => n > 0);

async function screen(page, path, heading) {
  await page.goto(base + path);
  // Título da tela ou estado vazio (antes da primeira leitura): os dois são resposta válida.
  await page.getByText(new RegExp(`${heading}|A primeira leitura do estoque ainda não terminou`)).first()
    .waitFor({ timeout: 45000 });
  const failed = await page.getByText('Não foi possível carregar o estoque').count();
  if (failed) throw new Error(`${path}: mensagem de falha na tela`);
  return { empty: (await page.getByText('A primeira leitura do estoque ainda não terminou').count()) > 0 };
}

(async () => {
  const browser = await chromium.launch();
  try {
    const sup = await open(browser);
    await step('super: entra', () => login(sup.page, 'super'));
    await step('super: menu', async () => {
      const visible = await menuHasStock(sup.page);
      const expected = mode !== 'off';
      if (visible !== expected) throw new Error(`menu Estoque ${visible ? 'visível' : 'escondido'} no modo ${mode}`);
      return { visible };
    });
    await step('super: visão geral', () => screen(sup.page, '/estoque', 'Visão geral do estoque'));
    await step('super: todas as empresas', async () => {
      await sup.page.getByRole('radio', { name: 'Todas as minhas empresas' }).click();
      await sup.page.getByText(/Visão geral do estoque|A primeira leitura do estoque ainda não terminou/).first()
        .waitFor({ timeout: 45000 });
    });
    await step('super: posições', () => screen(sup.page, '/estoque/posicoes', 'Posições de estoque'));
    await step('super: simulação', () => screen(sup.page, '/estoque/simulacao', 'Simulação de liquidação'));
    await step('super: card no produto', async () => {
      await sup.page.goto(base + '/produtos');
      await sup.page.locator('table tbody tr td').first().click({ timeout: 45000 });
      await sup.page.getByRole('heading', { name: 'Estoque por local' }).waitFor({ timeout: 45000 });
    });
    const mobile = await open(browser, 390);
    await step('super: celular sem rolagem lateral', async () => {
      await login(mobile.page, 'super');
      await mobile.page.goto(base + '/estoque/posicoes');
      await mobile.page.getByText(/Posições de estoque|A primeira leitura/).first().waitFor({ timeout: 45000 });
      const wide = await mobile.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (wide > 2) throw new Error(`página ${wide}px mais larga que a tela`);
    });

    const ges = await open(browser);
    await step('gestor: entra', () => login(ges.page, 'gestor'));
    await step('gestor: menu e acesso', async () => {
      const visible = await menuHasStock(ges.page);
      if (visible !== (mode === 'on')) throw new Error(`menu do gestor ${visible ? 'visível' : 'escondido'} no modo ${mode}`);
      await ges.page.goto(base + '/estoque');
      if (mode === 'on') {
        await ges.page.getByText(/Visão geral do estoque|A primeira leitura/).first().waitFor({ timeout: 45000 });
      } else {
        await ges.page.getByText('ainda não foi liberado para o seu perfil').waitFor({ timeout: 45000 });
      }
      return { visible };
    });

    const ven = await open(browser);
    await step('vendedor: entra', () => login(ven.page, 'vendor'));
    await step('vendedor: sem custo e sem simulação', async () => {
      await ven.page.goto(base + '/estoque/simulacao');
      if (mode !== 'on') {
        await ven.page.getByText('ainda não foi liberado para o seu perfil').waitFor({ timeout: 45000 });
        return { mode };
      }
      await ven.page.getByText('Seu perfil pode ver quantidades, mas não custos ou simulações.').first()
        .waitFor({ timeout: 45000 });
      await ven.page.goto(base + '/estoque/posicoes');
      await ven.page.getByText(/Posições de estoque|A primeira leitura/).first().waitFor({ timeout: 45000 });
      if (await ven.page.getByRole('columnheader', { name: 'CMC' }).count())
        throw new Error('vendedor viu a coluna CMC');
      return { mode };
    });
  } finally {
    await browser.close();
  }
  const ok = steps.every((s) => s.ok) && !problems.errors.length && !problems.serverFailures.length && !problems.csp.length;
  console.log(JSON.stringify({ ok, mode, steps, problems }, null, 1));
  process.exitCode = ok ? 0 : 1;
})();
