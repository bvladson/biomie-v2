'use strict';

// Real, read-only browser verification. Accounts must be short-lived accounts
// provisioned/removed by the caller (same in-memory format as ops/29_smoke.py).
// No credentials, cookies, sessions, account files or HAR/traces are persisted.
// This script does not create accounts, publish releases or request Omie jobs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

let accounts = [];
try { accounts = JSON.parse(process.env.BIOMIE_SMOKE_ACCOUNTS || '[]'); }
catch { /* Report a generic configuration error below, never the JSON payload. */ }
if (!Array.isArray(accounts)) accounts = [];

const redact = value => {
  let text = String(value)
    .replace(/(authorization|cookie|apikey|x-api-key)\s*:\s*[^\n']+/gi, '$1: [redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[jwt]');
  for (const account of accounts) {
    for (const key of ['password', 'email']) {
      const secret = account && account[key];
      if (typeof secret === 'string' && secret) text = text.split(secret).join('[redacted]');
    }
  }
  return text.slice(0, 600);
};

const report = { ok: false, authenticated: false, mocked: false, steps: [],
  problems: { browser: [], serverFailures: [], csp: [], upstream: [] }, assets: [], screenshots: [] };

async function step(name, work) {
  const started = Date.now();
  try {
    const detail = await work();
    report.steps.push({ step: name, ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) });
    return detail;
  } catch (error) {
    report.steps.push({ step: name, ok: false, ms: Date.now() - started, error: redact(error.message).split('\n')[0] });
    throw error;
  }
}

async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

async function screenshot(page, directory, prefix, label) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${prefix}-${label}.png`);
  await page.screenshot({ path: file, fullPage: false });
  const detail = { label, path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  report.screenshots.push(detail);
  return detail;
}

(async () => {
  let browser;
  let context;
  try {
    assert.ok(process.env.BIOMIE_TEST_URL, 'BIOMIE_TEST_URL must identify the intended deployed web');
    const site = new URL(process.env.BIOMIE_TEST_URL);
    assert.ok(['http:', 'https:'].includes(site.protocol) && !site.username && !site.password,
      'The test URL must be HTTP(S), without embedded credentials');
    const base = site.origin;
    const label = process.env.BIOMIE_SMOKE_LABEL;
    const account = label ? accounts.find(candidate => candidate.label === label)
      : accounts.find(candidate => candidate.label === 'super')
        || accounts.find(candidate => candidate.label === 'admin')
        || accounts.find(candidate => candidate.label === 'viewer')
        || accounts.find(candidate => candidate.label === 'common');
    assert.ok(account && typeof account.email === 'string' && account.email
      && typeof account.password === 'string' && account.password,
      'An ephemeral account with email/password must be provided in BIOMIE_SMOKE_ACCOUNTS');
    const minimumRows = Number(process.env.BIOMIE_SCROLL_MIN_ROWS || 20);
    assert.ok(Number.isInteger(minimumRows) && minimumRows >= 20, 'The regression needs at least 20 real rows');
    const shots = path.resolve(process.env.BIOMIE_SMOKE_SHOTS || path.join(__dirname, '../logs/floating-scroll-production'));
    const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const prefix = (process.env.BIOMIE_SMOKE_SHOT_PREFIX || `floating-scroll-${stamp}`).replace(/[^a-z0-9_-]/gi, '-');
    report.account = account.label;
    report.origin = base;
    report.previewProxy = Boolean(process.env.BIOMIE_TEST_UPSTREAM);

    browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
    report.browser = browser.version();
    context = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', error => report.problems.browser.push(redact(error.message)));
    page.on('console', message => {
      const text = message.text();
      if (/Content Security Policy|Refused to/i.test(text)) report.problems.csp.push(redact(text));
      else if (message.type() === 'error') report.problems.browser.push(redact(text));
    });
    page.on('response', response => {
      const url = new URL(response.url());
      if (response.status() >= 500)
        report.problems.serverFailures.push({ path: url.pathname, status: response.status() });
      if (url.origin === base && /^\/assets\/.*\.(?:js|css)$/.test(url.pathname) && !report.assets.includes(url.pathname))
        report.assets.push(url.pathname);
    });

    // Optional pre-cutover transport: the browser keeps the production origin,
    // while exact web responses come from an SSH tunnel to the candidate image.
    // Authentication/API continues through the actual public Supabase gateway.
    if (process.env.BIOMIE_TEST_UPSTREAM) {
      const upstreamURL = new URL(process.env.BIOMIE_TEST_UPSTREAM);
      assert.ok(['http:', 'https:'].includes(upstreamURL.protocol) && !upstreamURL.username && !upstreamURL.password,
        'The candidate upstream must be HTTP(S), without embedded credentials');
      const upstream = upstreamURL.origin;
      await page.route(base + '/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/supabase/')) return route.continue();
        const headers = { ...route.request().headers() };
        if (headers.origin) headers.origin = upstream;
        if (headers.referer) headers.referer = headers.referer.replace(base, upstream);
        delete headers.host;
        try {
          const response = await route.fetch({ url: upstream + url.pathname + url.search, headers, timeout: 90000 });
          await route.fulfill({ response });
        } catch (error) {
          report.problems.upstream.push({ path: url.pathname, error: redact(error.message).split('\n')[0] });
          await route.abort().catch(() => {});
        }
      });
    }

    await step('authenticated real login', async () => {
      await page.goto(base + '/auth');
      await page.getByRole('button', { name: 'Entrar', exact: true }).waitFor({ timeout: 45000 });
      await page.getByLabel('E-mail ou usuário').fill(account.email);
      await page.getByLabel('Senha', { exact: true }).fill(account.password);
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();
      await page.waitForURL('**/cockpit**', { timeout: 60000 });
      await page.getByRole('combobox', { name: 'Empresa', exact: true }).waitFor({ timeout: 45000 });
      report.authenticated = true;
    });

    await step('select Mag Filial through URL-backed company filter', async () => {
      const company = page.getByRole('combobox', { name: 'Empresa', exact: true });
      if (!/mag.*filial/i.test(await company.innerText())) {
        await company.click();
        const filial = page.getByRole('option').filter({ hasText: /mag.*filial/i }).first();
        await filial.waitFor({ timeout: 15000 });
        await filial.click();
        await until(async () => /mag.*filial/i.test(await company.innerText()), 'The requested real company was selected');
      }
      // Global filters in this application are URL search state, not business writes.
      return { selected: true };
    });

    const table = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Pendente', exact: true }) }).first();
    await step('load real stock positions with curve A', async () => {
      const previous = new URL(page.url());
      const target = new URL('/estoque/posicoes', base);
      for (const key of ['company', 'period']) {
        if (previous.searchParams.has(key)) target.searchParams.set(key, previous.searchParams.get(key));
      }
      target.searchParams.set('view', JSON.stringify('product'));
      target.searchParams.set('curve', JSON.stringify('A'));
      await page.goto(target.href);
      await page.getByRole('heading', { name: 'Posições de estoque', exact: true }).waitFor({ timeout: 60000 });
      await table.waitFor({ timeout: 60000 });
      await until(async () => await table.locator('tbody tr').count() >= minimumRows,
        'Real curve A results did not provide the required long-table rows', 45000);
      return { rows: await table.locator('tbody tr').count(), lastColumn: 'Pendente' };
    });

    await until(() => table.evaluate(element => Boolean(element.parentElement.getAttribute('data-biomie-floating-scroll-source'))),
      'The deployed global controller did not discover the real table');
    const id = await table.evaluate(element => element.parentElement.getAttribute('data-biomie-floating-scroll-source'));
    const source = page.locator(`[data-biomie-floating-scroll-source="${id}"]`);
    const bar = page.locator(`.biomie-floating-scroll[data-biomie-floating-scroll-for="${id}"]`);
    const scroller = bar.locator('.biomie-floating-scroll__viewport');
    const position = () => source.evaluate(element => ({ left: element.scrollLeft, max: element.scrollWidth - element.clientWidth }));

    await step('floating bar visible before the last row/native scrollbar', async () => {
      await table.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const offset = Math.min(600, Math.max(0, rect.height - innerHeight - 200));
        window.scrollTo(0, scrollY + rect.top + offset);
      });
      await until(() => bar.isVisible(), 'The floating scrollbar is missing while the real table continues below the viewport');
      const bounds = await bar.boundingBox();
      const native = await source.boundingBox();
      assert.ok(bounds && bounds.width > 64 && bounds.height > 0, 'The floating track must be usable');
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 769, 'Floating bar must stay in the viewport');
      assert.ok(native.y + native.height > 848, 'The native bottom scrollbar must remain out of view');
      assert.ok(bounds.x >= Math.max(0, native.x) - 2 && bounds.x + bounds.width <= Math.min(1366, native.x + native.width) + 2,
        'Floating bar must remain inside the visible table width');
      assert.ok(await table.locator('tbody tr').last().evaluate(element => element.getBoundingClientRect().top > innerHeight),
        'The last row must still be outside the viewport');
      await screenshot(page, shots, prefix, 'middle-first-columns');
      return { floating: bounds, source: native, viewport: { width: 1366, height: 768 } };
    });

    await step('real native thumb mouse drag reaches Pendente and returns', async () => {
      await source.evaluate(element => { element.scrollLeft = 0; });
      await until(() => scroller.evaluate(element => element.scrollLeft <= 1), 'Floating start must synchronize before mouse input');
      const geometry = await scroller.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width,
          gutter: element.offsetHeight - element.clientHeight, proportion: element.clientWidth / element.scrollWidth };
      });
      assert.ok(geometry.gutter >= 10 && geometry.proportion < 0.99, 'A rendered native thumb with a scroll range is required');
      const thumbWidth = (geometry.width - geometry.gutter * 2) * geometry.proportion;
      const y = geometry.bottom - geometry.gutter / 2;
      await page.mouse.move(geometry.left + geometry.gutter + thumbWidth / 2, y);
      await page.mouse.down();
      await page.mouse.move(geometry.right - 2, y, { steps: 24 });
      await page.mouse.up();
      await until(async () => { const p = await position(); return p.max - p.left <= 2; }, 'Real mouse drag did not reach the source right edge');
      assert.ok(await table.evaluate(element => {
        const th = element.querySelector('th:last-child');
        const last = th.getBoundingClientRect();
        const owner = element.parentElement.getBoundingClientRect();
        return th.textContent.trim() === 'Pendente' && last.right <= owner.right + 2 && last.left >= owner.left;
      }), 'The real Pendente column must be horizontally visible');
      const end = await position();
      await screenshot(page, shots, prefix, 'middle-pendente');
      await page.mouse.move(geometry.right - geometry.gutter - thumbWidth / 2, y);
      await page.mouse.down();
      await page.mouse.move(geometry.left + 2, y, { steps: 24 });
      await page.mouse.up();
      await until(async () => (await position()).left <= 2, 'Real mouse drag did not return to first columns');
      return { end, returnedToStart: true, lastColumn: 'Pendente' };
    });

    await step('native synchronization and keyboard reach both ends', async () => {
      await source.evaluate(element => { element.scrollLeft = (element.scrollWidth - element.clientWidth) * 0.43; });
      await until(async () => {
        const p = await position();
        return scroller.evaluate((element, owner) => Math.abs(element.scrollLeft / (element.scrollWidth - element.clientWidth)
          - owner.left / owner.max) * Math.min(element.scrollWidth - element.clientWidth, owner.max) <= 2.5, p);
      }, 'Native scroll did not synchronize the floating track');
      await scroller.focus();
      await page.keyboard.press('End');
      await until(async () => { const p = await position(); return p.max - p.left <= 2; }, 'Keyboard End did not expose last columns');
      await page.keyboard.press('Home');
      await until(async () => (await position()).left <= 2, 'Keyboard Home did not expose first columns');
      await screenshot(page, shots, prefix, 'middle-keyboard-home');
      return { synchronized: true, keyboard: ['End', 'Home'] };
    });

    await step('browser/server validation', async () => {
      assert.equal(report.problems.browser.length, 0, 'Browser errors occurred');
      assert.equal(report.problems.serverFailures.length, 0, 'Server errors occurred');
      assert.equal(report.problems.csp.length, 0, 'CSP violations occurred');
      assert.equal(report.problems.upstream.length, 0, 'Candidate web transport errors occurred');
      return { errors: 0 };
    });
    report.ok = true;
  } catch (error) {
    report.failure = redact(error.message).split('\n')[0];
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    // No storageState/traces/credentials are written; the caller deletes its account.
    console.log(JSON.stringify(report, null, 2));
  }
})();
