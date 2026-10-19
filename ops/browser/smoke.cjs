const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const context = JSON.parse(fs.readFileSync(path.join(root, 'ops/.test-context.json'), 'utf8'));
const base = process.env.BIOMIE_TEST_URL || 'https://biomie.magmoveiscorporativos.com.br';
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  if (process.env.BIOMIE_TEST_PREVIEW_PROXY === '1') {
    await page.route(base+'/**', async route => {
      const url=new URL(route.request().url());
      if(url.pathname.startsWith('/supabase/')) return route.continue();
      const headers={...route.request().headers()};
      if(headers.origin) headers.origin='http://127.0.0.1:33130';
      if(headers.referer) headers.referer=headers.referer.replace(base,'http://127.0.0.1:33130');
      delete headers.host;
      const response=await route.fetch({url:'http://127.0.0.1:33130'+url.pathname+url.search,headers});
      await route.fulfill({response});
    });
  }
  const errors = [];
  const failures = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => { if (message.type()==='error') console.log('CONSOLE_ERROR', message.text().slice(0,800)); });
  page.on('framenavigated', frame => { if (frame===page.mainFrame()) console.log('NAVIGATED',new URL(frame.url()).pathname); });
  page.on('response', r => { if(r.url().includes('/_server') || r.url().includes('/auth/v1')) console.log('AUTH_RESPONSE', r.status(), new URL(r.url()).pathname); });
  page.on('response', r => { if(r.status() >= 500) failures.push({ path: new URL(r.url()).pathname, status: r.status() }); });
  const visited=[];
  try {
    await page.goto(base + '/auth');
    await page.getByRole('button', { name: 'Entrar', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('form')?.getAttribute('aria-busy') || document.querySelector('form')?.getAttribute('aria-busy') === 'false');
    await page.waitForTimeout(2000);
    await page.getByLabel('E-mail ou usuário').fill(context.smoke.email);
    await page.getByLabel('Senha', { exact: true }).fill(context.smoke.password);
    console.log('FILLED',await page.locator('#email').inputValue()===context.smoke.email,await page.locator('#password').inputValue()===context.smoke.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await page.waitForURL('**/cockpit**', { timeout: 60000 });
    await page.getByRole('heading', { name: 'Visão Geral', exact: true }).waitFor();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(root, 'cockpit-desktop.png'), fullPage: true });
    for(const route of ['/plano-de-voo','/vendas','/vendedores','/clientes','/produtos','/financeiro','/qualidade-dos-dados','/integracoes','/admin']) {
      await page.goto(base + route);
      await page.locator('h1').first().waitFor({timeout:30000});
      await page.waitForTimeout(1000);
      const heading = await page.locator('h1').first().innerText();
      if(/didn't load|page not found|erro inesperado/i.test(heading)) throw new Error('Route failed: '+route);
      visited.push({ route, heading });
    }
    await page.setViewportSize({width:390,height:844});
    await page.goto(base+'/cockpit');
    await page.getByRole('heading',{name:'Visão Geral',exact:true}).waitFor();
    await page.waitForTimeout(1500);
    await page.screenshot({path:path.join(root,'cockpit-mobile.png'),fullPage:true});
    const result={login:'passed',routes:visited,errors,serverFailures:failures,desktop:true,mobile:true};
    fs.writeFileSync(path.join(root,'browser-smoke.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
    if(errors.length || failures.length) process.exitCode=1;
  } catch(e) {
    await page.screenshot({path:path.join(root,'browser-failure.png'),fullPage:true});
    console.error(e.message);
    console.error((await page.locator('body').innerText()).slice(-1800));
    process.exitCode=1;
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await browser.close();
  }
})();
