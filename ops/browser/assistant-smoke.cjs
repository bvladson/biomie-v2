// Assistente MAG AI (0052) no navegador, com contas de vida curta criadas por ops/29_smoke.py --ai.
// BIOMIE_AI_EXPECT:
//  - off: chave desligada — o balão não existe para ninguém (nem para o Super admin).
//  - on:  chave ligada para SUPER_ADMIN e ADMIN — o Super admin vê o balão, abre, usa uma sugestão e
//         uma pergunta digitada; SEM gateway no ambiente a resposta é "indisponível" com os números
//         da tela (fatos) — o caminho inteiro de fatos/catálogo/registro roda sem IA; o usuário
//         comum (VIEWER, fora da lista) não vê o balão.
// Senhas só em memória; a saída é um JSON por etapa, sem segredos.
const { chromium } = require('playwright');

const base = process.env.BIOMIE_TEST_URL || 'https://biomie.magmoveiscorporativos.com.br';
const accounts = JSON.parse(process.env.BIOMIE_SMOKE_ACCOUNTS || '[]');
const expect = process.env.BIOMIE_AI_EXPECT || 'off';

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

const balloon = (page) => page.getByRole('button', { name: /assistente BIOMIE/i });

async function balloonVisible(page) {
  // O menu carregado garante que o contexto (features) já chegou.
  await page.getByRole('link', { name: 'Cockpit', exact: true }).first().waitFor({ timeout: 45000 });
  await page.waitForTimeout(500);
  return (await balloon(page).count()) > 0;
}

(async () => {
  const browser = await chromium.launch();
  try {
    const sup = await open(browser);
    await step('super: entra', () => login(sup.page, 'admin'));
    await step(`super: balão ${expect === 'off' ? 'escondido' : 'visível'}`, async () => {
      const visible = await balloonVisible(sup.page);
      if (visible !== (expect !== 'off')) {
        throw new Error(`balão ${visible ? 'visível' : 'escondido'} com a chave ${expect}`);
      }
      return { visible };
    });

    if (expect !== 'off') {
      await step('super: abre o balão', async () => {
        await balloon(sup.page).click();
        await sup.page.getByRole('dialog', { name: 'Assistente BIOMIE' }).waitFor({ timeout: 15000 });
      });
      await step('super: aviso de IA ausente', async () => {
        // Sem MAG_AI_URL no ambiente o aviso aparece ao abrir (availability "off").
        await sup.page.getByText('A IA está desligada neste ambiente').waitFor({ timeout: 20000 });
      });
      await step('super: sugestão responde com os fatos', async () => {
        await sup.page.getByRole('button', { name: 'Explicar esta tela' }).click();
        await sup.page.getByText('A explicação automática está indisponível agora').waitFor({ timeout: 90000 });
        const dialog = sup.page.getByRole('dialog', { name: 'Assistente BIOMIE' });
        await dialog.getByText(/Números usados \(\d+\)/).first().waitFor({ timeout: 15000 });
      });
      await step('super: números usados abrem com FATOS', async () => {
        const dialog = sup.page.getByRole('dialog', { name: 'Assistente BIOMIE' });
        await dialog.getByText(/Números usados \(\d+\)/).first().click();
        await dialog.getByText(/FATOS — /).first().waitFor({ timeout: 10000 });
      });
      await step('super: pergunta fora do catálogo', async () => {
        const dialog = sup.page.getByRole('dialog', { name: 'Assistente BIOMIE' });
        await dialog.getByLabel('Pergunta ao assistente').fill('qual a previsão do tempo amanhã?');
        await dialog.getByLabel('Pergunta ao assistente').press('Enter');
        await dialog.getByText('Ainda não sei responder isso').waitFor({ timeout: 60000 });
      });
      await step('super: tela do estoque muda as sugestões', async () => {
        await sup.page.goto(base + '/estoque');
        await sup.page.getByText(/Visão geral do estoque|A primeira leitura do estoque ainda não terminou/)
          .first().waitFor({ timeout: 45000 });
        const dialog = sup.page.getByRole('dialog', { name: 'Assistente BIOMIE' });
        if ((await dialog.count()) === 0) await balloon(sup.page).click();
        await sup.page.getByRole('button', { name: 'O que está parado?' }).waitFor({ timeout: 15000 });
      });
      await step('super: admin mostra a aba do assistente', async () => {
        await sup.page.goto(base + '/admin');
        await sup.page.getByRole('tab', { name: 'Assistente (IA)' }).click({ timeout: 45000 });
        await sup.page.getByText('Assistente (IA local MAG AI)').waitFor({ timeout: 20000 });
        await sup.page.getByText('Uso nos últimos 7 dias').waitFor({ timeout: 10000 });
      });
    }
    await sup.context.close();

    const com = await open(browser);
    await step('comum: entra', () => login(com.page, 'common'));
    await step('comum: balão escondido (VIEWER fora da lista)', async () => {
      const visible = await balloonVisible(com.page);
      if (visible) throw new Error('balão visível para VIEWER');
      return { visible };
    });
    await com.context.close();
  } finally {
    await browser.close();
  }
  const failed = steps.filter((s) => !s.ok).length;
  console.log(JSON.stringify({ expect, steps, problems, failed }, null, 1));
  process.exit(failed || problems.serverFailures.length ? 1 : 0);
})();
