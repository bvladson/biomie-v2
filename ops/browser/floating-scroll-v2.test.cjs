'use strict';

// Local React regression fixture. It never starts the application server or calls
// Supabase/Omie. Only the fixture aliases below substitute route/data boundaries.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const repo = path.resolve(__dirname, '../..');
const sourceRoot = path.join(repo, 'source');
const fixtureRoot = path.join(__dirname, 'floating-scroll-v2');
const modules = path.join(sourceRoot, 'node_modules');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = process.env.FLOATING_SCROLL_ARTIFACTS || path.join(repo, 'ops/logs/floating-scroll-v2');
let server;
let browser;
let baseURL;
let viteModule;
let reactFactory;

before(async () => {
  const vite = await import(pathToFileURL(path.join(modules, 'vite/dist/node/index.js')).href);
  const react = (await import(pathToFileURL(path.join(modules, '@vitejs/plugin-react/dist/index.js')).href)).default;
  viteModule = vite;
  reactFactory = react;
  const tailwind = (await import(pathToFileURL(path.join(modules, '@tailwindcss/vite/dist/index.mjs')).href)).default;
  const normalized = value => value.replace(/\\/g, '/').replace(/\.(?:tsx?|jsx?)$/, '');
  server = await vite.createServer({
    root: fixtureRoot,
    configFile: false,
    logLevel: 'error',
    plugins: [{ name: 'isolated-stock-fixture-boundaries', enforce: 'pre', resolveId(id, importer, options) {
      if (options.ssr && /\/node_modules\/(?:react|react-dom)(?:\/|$)/.test(normalized(id)))
        return { id: require.resolve(id), external: true };
      if (!importer) return;
      const importerPath = normalized(importer.split('?')[0]);
      if (id === '@tanstack/react-router' && importerPath.endsWith('/estoque/pages/PositionsPage'))
        return path.join(fixtureRoot, 'route-stub.tsx');
      if (id.startsWith('.')) {
        const target = normalized(path.resolve(path.dirname(importer.split('?')[0]), id));
        if (target === normalized(path.join(sourceRoot, 'src/estoque/api')))
          return path.join(fixtureRoot, 'api-stub.ts');
        if (target === normalized(path.join(sourceRoot, 'src/estoque/components/StockLayout')))
          return path.join(fixtureRoot, 'page-title-stub.tsx');
      }
    } }, react(), tailwind()],
    resolve: {
      alias: {
        '@': path.join(sourceRoot, 'src'),
        'react': path.join(modules, 'react'),
        'react-dom': path.join(modules, 'react-dom'),
        '@tanstack/react-query': path.join(modules, '@tanstack/react-query'),
      },
      dedupe: ['react', 'react-dom', '@tanstack/react-query'],
    },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo, fs.realpathSync(modules)] } },
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', '@tanstack/react-query'] },
  });
  await server.listen();
  const address = server.httpServer.address();
  baseURL = `http://127.0.0.1:${address.port}/`;
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  console.log(`React V2 production PositionsPage; Chromium ${browser.version()}; loopback fixture only`);
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

async function until(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.fail(message);
}

async function setup(t, { width = 1366, height = 768, zoom = 1 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') { requests.push(url.hostname); return route.abort(); }
    return route.continue();
  });
  t.after(async () => {
    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, t.name.replace(/[^a-z0-9-]/gi, '-').slice(0, 135) + '.png') }).catch(() => {});
    await context.close();
    assert.deepEqual(errors, [], 'No unhandled errors, including React reconciliation/hydration errors');
    assert.deepEqual(requests, [], 'The fixture makes no requests outside loopback');
  });
  await page.goto(`${baseURL}?zoom=${zoom}`);
  await page.waitForFunction(() => document.querySelectorAll('#positions-slot tbody tr').length === 82);
  return page;
}

async function owner(page, selector = '#positions-slot table') {
  await until(() => page.locator(selector).evaluate(table => table.parentElement.hasAttribute('data-biomie-floating-scroll-source')),
    'Shared React Table wrapper is discovered after render');
  const id = await page.locator(selector).evaluate(table => table.parentElement.getAttribute('data-biomie-floating-scroll-source'));
  assert.ok(id, 'Shared React Table scroll wrapper is discovered');
  return { source: page.locator(`[data-biomie-floating-scroll-source="${id}"]`),
    bar: page.locator(`.biomie-floating-scroll[data-biomie-floating-scroll-for="${id}"]`) };
}

async function middle(page, selector = '#positions-slot table') {
  await page.locator(selector).evaluate(table => window.scrollTo(0, scrollY + table.getBoundingClientRect().top + 700));
  const result = await owner(page, selector);
  await until(() => result.bar.isVisible(), 'The floating bar is visible in the middle of the real PositionsPage');
  return result;
}

async function bounded(page, bar) {
  const rect = await bar.boundingBox();
  const viewport = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(rect && rect.width > 64 && rect.height > 0, 'A usable track is visible');
  assert.ok(rect.y >= 100 && rect.y + rect.height <= viewport.height + 1, 'Track remains inside the visible table viewport');
}

async function synchronized(source, scroller) {
  const a = await source.evaluate(element => ({ left: element.scrollLeft, max: element.scrollWidth - element.clientWidth }));
  const b = await scroller.evaluate(element => ({ left: element.scrollLeft, max: element.scrollWidth - element.clientWidth }));
  return Math.abs(a.left / a.max - b.left / b.max) * Math.min(a.max, b.max) <= 2.5;
}

test('global React component renders empty in SSR without window or document', async () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  const React = require(path.join(modules, 'react'));
  const { renderToString } = require(path.join(modules, 'react-dom/server.node.js'));
  // Separate SSR resolution: browser fixture aliases intentionally point to CJS
  // files for browser bundling; actual Node SSR must externalize React instead.
  const ssr = await viteModule.createServer({ root: sourceRoot, configFile: false,
    plugins: [reactFactory()], server: { middlewareMode: true }, logLevel: 'error',
    resolve: { alias: { '@': path.join(sourceRoot, 'src') } },
    ssr: { external: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'] } });
  try {
    const { GlobalFloatingTableScroll } = await ssr.ssrLoadModule(path.join(sourceRoot, 'src/components/layout/GlobalFloatingTableScroll.tsx'));
    assert.equal(renderToString(React.createElement(GlobalFloatingTableScroll)), '');
  } finally { await ssr.close(); }
});

for (const [width, height] of [[1920, 1080], [1366, 768], [900, 600]]) {
  for (const zoom of [1, 1.25, 1.5]) {
    test(`real PositionsPage midpoint ${width}x${height} CSS zoom ${zoom}`, async t => {
      const page = await setup(t, { width, height, zoom });
      const { source, bar } = await middle(page);
      await bounded(page, bar);
      const sourceBox = await source.boundingBox();
      assert.ok(sourceBox.y + sourceBox.height > height + 500, 'The native scrollbar is far below the viewport');
      const scroller = bar.locator('.biomie-floating-scroll__viewport');
      await source.evaluate(element => { element.scrollLeft = (element.scrollWidth - element.clientWidth) * 0.4; });
      await until(() => synchronized(source, scroller), 'Native source synchronizes floating position');
      await scroller.evaluate(element => { element.scrollLeft = element.scrollWidth; });
      await until(async () => source.evaluate(element => Math.abs(element.scrollWidth - element.clientWidth - element.scrollLeft) <= 2), 'Floating control reaches rightmost production column');
      const visibleLastColumn = await page.locator('#positions-slot table').evaluate(table => {
        const th = table.querySelector('th:last-child');
        const owner = table.parentElement.getBoundingClientRect();
        const last = th.getBoundingClientRect();
        return th.textContent === 'Pendente' && last.right <= owner.right + 2 && last.left >= owner.left;
      });
      assert.ok(visibleLastColumn, 'The actual Pendente column is visible without reaching the last row');
    });
  }
}

test('native mouse drag exposes Pendente midway through the real 82 rows', async t => {
  const page = await setup(t);
  const { source, bar } = await middle(page);
  const scroller = bar.locator('.biomie-floating-scroll__viewport');
  const geometry = await scroller.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width,
      gutter: element.offsetHeight - element.clientHeight, proportion: element.clientWidth / element.scrollWidth };
  });
  assert.ok(geometry.gutter >= 10, 'Native thumb is rendered and hit-testable');
  const thumb = (geometry.width - 2 * geometry.gutter) * geometry.proportion;
  const y = geometry.bottom - geometry.gutter / 2;
  await page.mouse.move(geometry.x + geometry.gutter + thumb / 2, y);
  await page.mouse.down();
  await page.mouse.move(geometry.right - 2, y, { steps: 24 });
  await page.mouse.up();
  await until(async () => source.evaluate(element => element.scrollWidth - element.clientWidth - element.scrollLeft <= 2), 'Actual native-thumb mouse drag reaches right edge');
  await page.mouse.move(geometry.right - geometry.gutter - thumb / 2, y);
  await page.mouse.down();
  await page.mouse.move(geometry.x + 2, y, { steps: 24 });
  await page.mouse.up();
  await until(async () => source.evaluate(element => element.scrollLeft <= 2), 'Mouse drag returns to first columns');
});

test('React filters, conditional unmount, StrictMode and controller remount preserve React-owned parents', async t => {
  const page = await setup(t);
  let result = await middle(page);
  await page.locator('#positions-slot table').evaluate(table => { window.fixtureTable = table; window.fixtureParent = table.parentElement; });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByLabel('Buscar produto ou SKU').fill('York');
  await until(async () => { const count = await page.locator('#positions-slot tbody tr').count(); return count > 0 && count < 82; }, 'Filter replaces actual query results');
  assert.equal(await page.evaluate(() => window.fixtureTable.parentElement === window.fixtureParent), true,
    'The controller never moves the original table; React may replace the whole loading subtree');
  await page.getByLabel('Buscar produto ou SKU').fill('');
  await until(async () => await page.locator('#positions-slot tbody tr').count() === 82, 'Clearing filter restores 82 rows');
  result = await owner(page);
  await page.locator('#toggle-page').click();
  await until(async () => await page.locator('#positions-slot table').count() === 0, 'React conditionally removes its table');
  await until(async () => await result.bar.count() === 0, 'Detached source overlay is cleaned up; unrelated hidden tables keep their own records');
  await page.locator('#toggle-page').click();
  await page.waitForFunction(() => document.querySelectorAll('#positions-slot tbody tr').length === 82);
  result = await middle(page);
  assert.equal(await page.locator('.biomie-floating-scroll:visible').count(), 1, 'StrictMode and remount create only one track');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('#toggle-controller').click();
  assert.equal(await page.locator('.biomie-floating-scroll').count(), 0, 'Effect cleanup removes overlay');
  await page.locator('#toggle-controller').click();
  await middle(page);
  assert.equal(await page.locator('.biomie-floating-scroll:visible').count(), 1);
});

test('native accessible scrollbar and table without overflow do not duplicate tracks', async t => {
  const page = await setup(t);
  let result = await middle(page);
  await result.source.evaluate(element => window.scrollTo(0, scrollY + element.getBoundingClientRect().bottom - innerHeight + 120));
  await until(async () => !await result.bar.isVisible(), 'Floating track hides when native scrollbar is visible');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('#fit-table').click();
  await page.locator('#fit-panel table').evaluate(table => window.scrollTo(0, scrollY + table.getBoundingClientRect().top + 300));
  await page.waitForTimeout(100);
  const fit = await owner(page, '#fit-panel table');
  assert.equal(await fit.source.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
  assert.equal(await fit.bar.isVisible(), false, 'Fitting table has no floating control');
});

test('Radix Sheet keeps its scrollbar in the panel focus scope and above action footer', async t => {
  const page = await setup(t);
  await page.locator('#open-sheet').click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await page.locator('#fixture-sheet-body').evaluate(element => { element.scrollTop = 600; });
  const { source, bar } = await owner(page, '#fixture-sheet-body table');
  await until(() => bar.isVisible(), 'Radix Sheet table gets a visible track');
  assert.equal(await bar.evaluate(element => Boolean(element.closest('[role=dialog]'))), true, 'Track belongs to the actual Radix focus trap');
  const rect = await bar.boundingBox();
  const footer = await page.locator('#fixture-sheet-footer').boundingBox();
  assert.ok(rect.y + rect.height <= footer.y + 1, 'Track never covers footer actions');
  await bar.locator('[role=scrollbar]').focus();
  assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('[role=dialog]'))), true);
  await page.keyboard.press('End');
  await until(async () => source.evaluate(element => element.scrollWidth - element.clientWidth - element.scrollLeft <= 2), 'Keyboard reaches panel rightmost columns');
  await page.keyboard.press('Escape');
  await until(async () => !await bar.isVisible(), 'Closing Sheet removes its track');
});

test('mobile viewport preserves horizontal access through native keyboard and wheel events', async t => {
  const page = await setup(t, { width: 390, height: 844 });
  const { source, bar } = await middle(page);
  await bounded(page, bar);
  const scroller = bar.locator('.biomie-floating-scroll__viewport');
  await scroller.focus();
  await page.keyboard.press('End');
  await until(async () => source.evaluate(element => element.scrollWidth - element.clientWidth - element.scrollLeft <= 2), 'Mobile-sized viewport reaches last columns');
  await page.keyboard.press('Home');
  await scroller.hover();
  await page.mouse.wheel(180, 0);
  await until(async () => source.evaluate(element => element.scrollLeft > 20), 'Horizontal wheel synchronizes mobile-sized source');
});

test('actual PositionsPage at native Chromium tab zoom, including reduced window', async t => {
  // chrome.tabs.setZoom is native browser tab zoom, rather than CSS or DPR emulation.
  // https://developer.chrome.com/docs/extensions/reference/api/tabs#method-setZoom
  const prefix = 'biomie-v2-floating-native-zoom-';
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const extension = path.join(temp, 'extension');
  fs.mkdirSync(extension);
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3,
    name: 'BIOMIE local V2 native zoom verification', version: '1.0.0',
    host_permissions: ['http://127.0.0.1/*'], background: { service_worker: 'background.js' } }));
  fs.writeFileSync(path.join(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  let context;
  try {
    for (const windowSize of [[1366, 768], [900, 600]]) {
      context = await chromium.launchPersistentContext(path.join(temp, `profile-${windowSize[0]}`), {
        channel: 'chromium', headless: true, viewport: null, reducedMotion: 'reduce',
        ignoreDefaultArgs: ['--hide-scrollbars'],
        args: [`--window-size=${windowSize[0]},${windowSize[1]}`,
          `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      });
      let worker = context.serviceWorkers()[0];
      if (!worker) worker = await context.waitForEvent('serviceworker');
      for (const factor of windowSize[0] === 1366 ? [1, 1.25, 1.5] : [1.5]) {
        await t.test(`native zoom ${factor * 100}% in ${windowSize[0]}x${windowSize[1]}`, async child => {
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          child.after(async () => {
            await page.screenshot({ path: path.join(artifacts, `native-zoom-${windowSize[0]}-${factor * 100}.png`) });
            await page.close();
            assert.deepEqual(errors, []);
          });
          await page.goto(baseURL);
          await page.waitForFunction(() => document.querySelectorAll('#positions-slot tbody tr').length === 82);
          const baseline = await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }));
          const reported = await worker.evaluate(async ({ url, zoom }) => {
            const tabs = await chrome.tabs.query({});
            const tab = tabs.find(candidate => candidate.url === url);
            await chrome.tabs.setZoomSettings(tab.id, { mode: 'automatic', scope: 'per-tab' });
            await chrome.tabs.setZoom(tab.id, zoom);
            return chrome.tabs.getZoom(tab.id);
          }, { url: page.url(), zoom: factor });
          assert.ok(Math.abs(reported - factor) < 0.001, 'Browser reports actual tab zoom');
          await until(() => page.evaluate(({ baseline, factor }) => Math.abs(devicePixelRatio / baseline.dpr - factor) < 0.02
            && Math.abs(innerWidth - baseline.width / factor) <= 2, { baseline, factor }), 'Native zoom changes DPR and CSS viewport');
          assert.equal(await page.evaluate(() => Number(getComputedStyle(document.documentElement).zoom)), 1, 'CSS zoom remains one');
          assert.equal(await page.evaluate(() => visualViewport.scale), 1, 'No pinch zoom substitutes tab zoom');
          const { source, bar } = await middle(page);
          await bounded(page, bar);
          await bar.locator('.biomie-floating-scroll__viewport').evaluate(element => { element.scrollLeft = element.scrollWidth; });
          await until(async () => source.evaluate(element => element.scrollWidth - element.clientWidth - element.scrollLeft <= 2), 'Native-zoom control reaches actual Pendente column');
          console.log(JSON.stringify({ window: windowSize, nativeZoom: factor, actual: await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio })) }));
        });
      }
      await context.close();
      context = null;
    }
  } finally {
    if (context) await context.close();
    // Resolve and validate the final Windows/OS path before recursive removal.
    const root = fs.realpathSync(os.tmpdir());
    const target = fs.realpathSync(temp);
    const relative = path.relative(root, target);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.ok(path.basename(target).startsWith(prefix));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
