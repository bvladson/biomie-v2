// Admin 2.0 end-to-end browser test on the public site, with short-lived accounts created by
// ops/29_smoke.py --admin. Links and passwords live only in memory: never printed, never written.
// Output: JSON with one entry per step (no secrets).
const { chromium } = require('playwright');
const crypto = require('node:crypto');

const base = process.env.BIOMIE_TEST_URL || 'https://biomie.magmoveiscorporativos.com.br';
const accounts = JSON.parse(process.env.BIOMIE_SMOKE_ACCOUNTS || '[]');
const stamp = process.env.BIOMIE_SMOKE_STAMP || String(Date.now());
const COMPANY = 'Mag Moveis - Filial';
const account = (label) => accounts.find((a) => a.label === label);
const redact = (text) => String(text)
  .replace(/(authorization|cookie|apikey|x-api-key)\s*:\s*[^\n']+/gi, '$1: [redacted]')
  .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
  .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[jwt]')
  .replace(/token=[^&\s"']+/gi, 'token=[redacted]')
  .replace(/#access_token=[^\s"']+/gi, '#[redacted]');
const strongPassword = () => `Bm!${crypto.randomBytes(12).toString('base64url')}7a`;

const steps = [];
const problems = { errors: [], serverFailures: [], csp: [] };

async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    steps.push({ step: name, ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) });
    return true;
  } catch (e) {
    steps.push({ step: name, ok: false, ms: Date.now() - started, error: redact(e.message).split('\n')[0].slice(0, 300) });
    return false;
  }
}

async function open(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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

async function login(page, email, password, landing = '**/cockpit**') {
  await page.goto(base + '/auth');
  await page.getByRole('button', { name: 'Entrar', exact: true }).waitFor();
  await page.getByLabel('E-mail ou usuário').fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL(landing, { timeout: 60000 });
}

/** Wizard: identificação → acesso (Visualizador na MAG Filial) → entrega → revisão. Returns the secret. */
async function createViaWizard(page, { name, email, delivery }) {
  await page.goto(base + '/admin/usuarios/novo');
  await page.getByRole('heading', { name: 'Novo usuário', exact: true }).waitFor({ timeout: 30000 });
  await page.locator('#nu-name').fill(name);
  await page.locator('#nu-email').fill(email);
  await page.getByRole('button', { name: 'Avançar' }).click();
  await page.locator('#role-VIEWER').click();
  await page.locator('label', { hasText: COMPANY }).locator('button[role=checkbox]').click();
  await page.getByRole('button', { name: 'Avançar' }).click();
  if (delivery === 'TEMP_PASSWORD') await page.locator('#d-pass').click();
  await page.getByRole('button', { name: 'Avançar' }).click();
  await page.getByRole('button', { name: 'Confirmar e criar usuário' }).click();
  await page.getByRole('heading', { name: 'Usuário criado', exact: true }).waitFor({ timeout: 60000 });
  return page.locator('#secret-value').inputValue();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const superAcc = account('super');
  const tenant = account('tenant');
  const vendor = account('vendor');
  const invited = { name: 'Smoke Convite', email: `smoke-invite-${stamp}@biomie.invalid` };
  const temporary = { name: 'Smoke Temporaria', email: `smoke-temp-${stamp}@biomie.invalid` };
  let inviteLink = null;
  let tempPassword = null;

  const admin = await open(browser);
  await step('super: lista de usuários', async () => {
    await login(admin.page, superAcc.email, superAcc.password);
    await admin.page.goto(base + '/admin/usuarios');
    await admin.page.getByRole('heading', { name: 'Usuários', exact: true }).waitFor({ timeout: 30000 });
    await admin.page.locator('table tbody tr').first().waitFor({ timeout: 30000 });
    return { rows: await admin.page.locator('table tbody tr').count() };
  });
  await step('super: cria por convite', async () => {
    inviteLink = await createViaWizard(admin.page, { ...invited, delivery: 'INVITE_LINK' });
    if (!inviteLink.startsWith(base + '/supabase/auth/v1/verify?'))
      throw new Error('link de convite fora do endereço público esperado');
    return { link: 'gerado (não exibido)' };
  });
  await step('super: bloqueia e reativa', async () => {
    const page = admin.page;
    await page.getByRole('button', { name: 'Concluir e ver o usuário' }).click();
    await page.getByRole('heading', { name: invited.name, exact: true }).waitFor({ timeout: 30000 });
    await page.getByRole('tab', { name: 'Segurança' }).click();
    await page.getByRole('button', { name: 'Bloquear acesso' }).click();
    await page.locator('#b-reason').fill('Teste automático do Admin');
    await page.getByRole('button', { name: 'Bloquear', exact: true }).click();
    // Aviso na tela + notificação: o mesmo texto aparece duas vezes.
    await page.getByText('Acesso bloqueado.').first().waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Reativar', exact: true }).click();
    await page.locator('#b-reason').fill('Teste automático do Admin');
    await page.getByRole('dialog').getByRole('button', { name: 'Reativar', exact: true }).click();
    await page.getByText('Acesso bloqueado.').first().waitFor({ state: 'detached', timeout: 30000 });
  });

  await step('convite: link abre a página de senha e entra no Cockpit', async () => {
    if (!inviteLink) throw new Error('sem link de convite');
    const guest = await open(browser);
    try {
      await guest.page.goto(inviteLink);
      await guest.page.waitForURL('**/reset-password**', { timeout: 60000 });
      await guest.page.getByRole('heading', { name: 'Definir nova senha' }).waitFor({ timeout: 30000 });
      await guest.page.locator('#pw').fill(strongPassword());
      await guest.page.getByRole('button', { name: 'Salvar senha' }).click();
      await guest.page.waitForURL('**/cockpit**', { timeout: 60000 });
      await guest.page.getByRole('heading', { name: 'Visão Geral', exact: true }).waitFor({ timeout: 60000 });
    } finally {
      await guest.context.close();
    }
  });

  await step('super: exclui pela tela', async () => {
    const page = admin.page;
    await page.reload();
    await page.getByRole('tab', { name: 'Segurança' }).click();
    await page.getByRole('button', { name: 'Excluir usuário' }).click();
    await page.locator('#d-email').fill(invited.email);
    await page.getByRole('button', { name: 'Excluir definitivamente' }).click();
    await page.waitForURL('**/admin/usuarios**', { timeout: 30000 });
  });

  await step('super: cria com senha temporária', async () => {
    tempPassword = await createViaWizard(admin.page, { ...temporary, delivery: 'TEMP_PASSWORD' });
    if (!tempPassword || tempPassword.length < 12) throw new Error('senha temporária não exibida');
  });
  await step('senha temporária: primeiro acesso exige a troca', async () => {
    const guest = await open(browser);
    try {
      await login(guest.page, temporary.email, tempPassword, '**/definir-senha**');
      const next = strongPassword();
      await guest.page.locator('#new-pw').fill(next);
      await guest.page.locator('#new-pw-confirm').fill(next);
      await guest.page.getByRole('button', { name: 'Salvar e entrar' }).click();
      await guest.page.waitForURL('**/cockpit**', { timeout: 60000 });
    } finally {
      await guest.context.close();
    }
  });
  await admin.context.close();

  const t = await open(browser);
  await step('admin da empresa: só a própria empresa e sem papéis de administração', async () => {
    await login(t.page, tenant.email, tenant.password);
    await t.page.goto(base + '/admin/usuarios');
    await t.page.locator('table tbody tr').first().waitFor({ timeout: 30000 });
    if (await t.page.getByRole('link', { name: 'Smoke Super', exact: true }).count())
      throw new Error('Admin da empresa vê o Super admin sem empresa');
    await t.page.goto(base + '/admin/usuarios/novo');
    await t.page.locator('#nu-name').fill('Smoke Nunca Criado');
    await t.page.locator('#nu-email').fill(`smoke-never-${stamp}@biomie.invalid`);
    await t.page.getByRole('button', { name: 'Avançar' }).click();
    await t.page.locator('#role-VIEWER').waitFor({ timeout: 30000 });
    if ((await t.page.locator('#role-ADMIN').count()) || (await t.page.locator('#role-SUPER_ADMIN').count()))
      throw new Error('Admin da empresa pode dar papel de administração');
    if (await t.page.locator('label', { hasText: 'Ergo Office' }).locator('button[role=checkbox]:not([disabled])').count())
      throw new Error('Admin da empresa pode conceder outra empresa');
  });
  await t.context.close();

  const v = await open(browser);
  await step('vendedor: barrado no Admin, Minha conta aberta', async () => {
    await login(v.page, vendor.email, vendor.password);
    await v.page.goto(base + '/admin/usuarios');
    await v.page.getByText('Acesso restrito a administradores.').first().waitFor({ timeout: 30000 });
    await v.page.goto(base + '/minha-conta');
    await v.page.getByRole('heading', { name: 'Minha conta', exact: true }).waitFor({ timeout: 30000 });
  });
  await v.context.close();

  await browser.close();
  console.log(JSON.stringify({ steps, ...problems }, null, 2));
  if (steps.some((s) => !s.ok) || problems.serverFailures.length || problems.csp.length) process.exitCode = 1;
})();
