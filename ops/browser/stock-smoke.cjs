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
// BIOMIE_STOCK_CURVES=1 (29_smoke.py --curves): passos da curva automática (migração 0043).
// =ro (29_smoke.py --curves-readonly, para a PRODUÇÃO): os mesmos passos sem a curva manual (não grava nada).
const curves = ['1', 'ro'].includes(process.env.BIOMIE_STOCK_CURVES);
const curvesWrite = process.env.BIOMIE_STOCK_CURVES === '1';
// BIOMIE_STOCK_INTEL=1 (29_smoke.py --intel): Inteligência (0044) com análise publicada;
// =empty (--intel-empty): a tela abre e avisa que ainda não há análise. Só leitura nos dois casos.
const intel = process.env.BIOMIE_STOCK_INTEL;
// BIOMIE_STOCK_SUPPLIERS=1 (29_smoke.py --suppliers): fornecedores e prazos (0048/0049). Só leitura: os
// diálogos abrem e não salvam sem observação; nada é gravado.
const suppliers = process.env.BIOMIE_STOCK_SUPPLIERS === '1';
// Bloco de prazos da aba Reposição: o da 0048 de 25/10 ou o de fornecedores (0049).
const REPL_HEADING = /^(Prazos de reposição|Prazos de entrega e política de reposição)$/;
// Primeiro número do texto, no formato do Brasil (1.234 = mil duzentos e trinta e quatro).
const firstNumber = (text) => {
  const m = /\d[\d.]*/.exec(String(text));
  return m ? Number(m[0].replace(/\./g, '')) : null;
};
async function until(check, ms = 30000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last.ok) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}
const shotsDir = process.env.BIOMIE_SMOKE_SHOTS;
const shotPrefix = process.env.BIOMIE_SMOKE_SHOT_PREFIX;
async function shot(page, name, fullPage = true) {
  if (!shotsDir || !shotPrefix) return null;
  const file = require('node:path').join(shotsDir, `${shotPrefix}-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  return file;
}
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

// Espera o menu lateral carregar (o Cockpit aparece para todos) antes de contar o Estoque.
const menuHasStock = async (page) => {
  await page.getByRole('link', { name: 'Cockpit', exact: true }).first().waitFor({ timeout: 45000 });
  return (await page.getByRole('link', { name: 'Estoque', exact: true }).count()) > 0;
};

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
    if (curves) {
      await step('super: janela da curva', async () => {
        await sup.page.goto(base + '/estoque');
        await sup.page.getByText(/Distribuição por curva/).first().waitFor({ timeout: 45000 });
        await sup.page.getByRole('radio', { name: '90 dias' }).click();
        await sup.page.getByText('Distribuição por curva · 90 dias').waitFor({ timeout: 45000 });
        await sup.page.getByRole('radio', { name: '12 meses' }).click();
        await sup.page.getByText('Distribuição por curva · 12 meses').waitFor({ timeout: 45000 });
        const info = await sup.page.getByText(/Curva automática de 12 meses/).first().innerText();
        return { info: info.slice(0, 200), shot: await shot(sup.page, 'visao-geral-12m') };
      });
      await step('super: curva D aberta e tempo sem venda', async () => {
        await sup.page.getByRole('heading', { name: /Curva D aberta/ }).waitFor({ timeout: 45000 });
        await sup.page.getByRole('heading', { name: /Tempo sem venda/ }).waitFor({ timeout: 45000 });
        const heading = await sup.page.getByRole('heading', { name: /Curva D aberta/ }).innerText();
        await sup.page.getByRole('link', { name: /Histórico incompleto/ }).first().click();
        await sup.page.waitForURL(/\/estoque\/posicoes/, { timeout: 45000 });
        await sup.page.getByRole('columnheader', { name: 'Indicadores' }).waitFor({ timeout: 45000 });
        await sup.page.getByText(/produtos? · página/).waitFor({ timeout: 45000 });
        return { heading, url: new URL(sup.page.url()).search, shot: await shot(sup.page, 'curva-d-historico-incompleto') };
      });
      await step('super: curva D com saída recente', async () => {
        await sup.page.goto(base + '/estoque');
        await sup.page.getByRole('heading', { name: /Curva D aberta/ }).waitFor({ timeout: 45000 });
        const card = sup.page.getByRole('link', { name: /Com saída nos últimos 90 dias/ }).first();
        const text = (await card.innerText()).replace(/\s+/g, ' ');
        await card.click();
        await sup.page.waitForURL(/recentExit=true/, { timeout: 45000 });
        await sup.page.getByText(/produtos? · página/).waitFor({ timeout: 45000 });
        const exitLine = sup.page.getByText(/^Saída \d{2}\/\d{2}\/\d{4} · /).first();
        await exitLine.waitFor({ timeout: 45000 });
        const full = await shot(sup.page, 'curva-d-saida-recente');
        // Colunas da direita (entrada/saída e indicadores): a tabela rola na horizontal.
        await exitLine.scrollIntoViewIfNeeded();
        const detail = await shot(sup.page, 'curva-d-saida-recente-detalhe', false);
        const group = sup.page.getByText('Venda para o grupo').first();
        const groupBadge = (await group.count()) > 0;
        let groupShot = null;
        if (groupBadge) {
          await group.scrollIntoViewIfNeeded();
          groupShot = await shot(sup.page, 'curva-d-venda-para-o-grupo', false);
        }
        return {
          card: text.slice(0, 160),
          exit: (await exitLine.innerText()).slice(0, 80),
          groupBadge,
          shots: [full, detail, groupShot],
        };
      });
      if (curvesWrite) await step('super: curva manual com justificativa e volta para a automática', async () => {
        await sup.page.goto(base + '/estoque/posicoes?curve=%22D%22&view=%22product%22');
        await sup.page.getByText(/produtos? · página/).waitFor({ timeout: 45000 });
        const first = sup.page.locator('table tbody tr').first();
        const name = (await first.locator('td').nth(1).innerText()).split('\n')[0];
        await first.getByRole('checkbox').click();
        await sup.page.getByRole('button', { name: /Classificar 1 selecionada/ }).click();
        await sup.page.getByRole('combobox', { name: 'Nova curva' }).click();
        await sup.page.getByRole('option', { name: 'Curva A (manual)' }).click();
        const confirm = sup.page.getByRole('button', { name: 'Confirmar classificação' });
        if (await confirm.isEnabled()) throw new Error('confirmou curva manual sem justificativa');
        await sup.page.getByLabel('Justificativa da curva').fill('Teste automático da homologação');
        const dialogShot = await shot(sup.page, 'classificar-com-justificativa');
        await confirm.click();
        await sup.page.getByText(/com curva manual A/).first().waitFor({ timeout: 45000 });
        await sup.page.goto(base + '/estoque/posicoes?onlyManual=true&view=%22product%22');
        await sup.page.getByText(/Manual · /).first().waitFor({ timeout: 45000 });
        const manualShot = await shot(sup.page, 'curva-manual');
        const row = sup.page.locator('table tbody tr').first();
        await row.getByRole('checkbox').click();
        await sup.page.getByRole('button', { name: /Classificar 1 selecionada/ }).click();
        await sup.page.getByRole('combobox', { name: 'Nova curva' }).click();
        await sup.page.getByRole('option', { name: 'Automática (voltar ao cálculo)' }).click();
        await sup.page.getByRole('button', { name: 'Confirmar classificação' }).click();
        await sup.page.getByText(/voltaram para a curva automática/).first().waitFor({ timeout: 45000 });
        return { product: name.slice(0, 80), shots: [dialogShot, manualShot] };
      });
    }
    if (intel === '1' || intel === 'empty') {
      await step('super: inteligência — painel', async () => {
        await sup.page.goto(base + '/estoque/inteligencia');
        await sup.page.getByRole('heading', { name: 'Inteligência do estoque' }).waitFor({ timeout: 60000 });
        if (!(await sup.page.getByRole('link', { name: 'Inteligência', exact: true }).count()))
          throw new Error('aba Inteligência ausente para o Super admin');
        if (intel === 'empty') {
          await sup.page.getByText('Nenhuma análise publicada ainda').waitFor({ timeout: 45000 });
          return { empty: true, shot: await shot(sup.page, 'inteligencia-vazia') };
        }
        await sup.page.getByRole('heading', { name: 'Radar do capital parado' }).waitFor({ timeout: 60000 });
        await sup.page.getByRole('heading', { name: 'Diagnóstico por estado' }).waitFor({ timeout: 45000 });
        await sup.page.getByText(/produtos? · página/).waitFor({ timeout: 60000 });
        if (await sup.page.getByText('Não foi possível carregar o estoque').count())
          throw new Error('mensagem de falha na tela');
        const run = (await sup.page.getByText(/Análise publicada em/).first().innerText()).slice(0, 220);
        const tiles = await sup.page.locator('#stock-main .panel').evaluateAll((els) =>
          els.slice(0, 6).map((e) => e.innerText.replace(/\s+/g, ' ').trim().slice(0, 90)));
        return { run, tiles, shot: await shot(sup.page, 'inteligencia') };
      });
      if (intel === '1') {
        await step('super: inteligência — card abre a lista com o mesmo total', async () => {
          const out = [];
          for (const label of [/Sem venda há mais de 180 dias/, /Produtos novos/]) {
            await sup.page.goto(base + '/estoque/inteligencia');
            const tile = sup.page.getByRole('button', { name: label }).first();
            await tile.waitFor({ timeout: 60000 });
            const value = firstNumber((await tile.innerText()).split('\n')[1]);
            await tile.click();
            await sup.page.waitForURL(/semVenda=|estado=/, { timeout: 45000 });
            const seen = await until(async () => {
              const text = await sup.page.getByText(/produtos? · página/).first().innerText().catch(() => '');
              return { ok: firstNumber(text) === value, text };
            });
            if (!seen.ok) throw new Error(`card ${value} × lista "${seen.text}"`);
            out.push({ card: String(label), value, list: seen.text });
          }
          return { cards: out, url: new URL(sup.page.url()).search.slice(0, 120) };
        });
        await step('super: inteligência — gaveta do produto', async () => {
          await sup.page.goto(base + '/estoque/inteligencia');
          await sup.page.getByText(/produtos? · página/).waitFor({ timeout: 60000 });
          const first = sup.page.locator('#intel-produtos table tbody tr').first().getByRole('button').first();
          const name = (await first.innerText()).slice(0, 80);
          await first.click();
          const dialog = sup.page.getByRole('dialog');
          await dialog.getByText('Por que este estado').waitFor({ timeout: 45000 });
          await dialog.getByText('Como a prioridade foi calculada').waitFor({ timeout: 45000 });
          const rule = (await dialog.locator('section').first().innerText()).replace(/\s+/g, ' ').slice(0, 300);
          const file = await shot(sup.page, 'inteligencia-produto', false);
          // Fases 3–5: as seções novas aparecem (mesmo que digam que não há dado para aquele produto).
          const sections = [];
          for (const title of ['Diagnóstico', 'Recomendações', 'Alertas', 'Previsão de demanda (30, 60 e 90 dias)',
                               'Reposição inteligente', 'Movimentações por semana', 'Oportunidades entre empresas']) {
            const h = dialog.getByRole('heading', { name: title, exact: true });
            await h.waitFor({ timeout: 45000 });
            sections.push(title);
          }
          await dialog.getByRole('heading', { name: 'Previsão de demanda (30, 60 e 90 dias)', exact: true }).scrollIntoViewIfNeeded();
          const forecastShot = await shot(sup.page, 'inteligencia-produto-previsao', false);
          await sup.page.keyboard.press('Escape');
          return { name, rule, sections, shots: [file, forecastShot] };
        });
        await step('super: inteligência — abas de alertas, reposição e entre empresas', async () => {
          const out = {};
          await sup.page.goto(base + '/estoque/inteligencia?aba=%22alertas%22');
          await sup.page.getByRole('button', { name: /Alertas abertos/ }).first().waitFor({ timeout: 60000 }).catch(async () => {
            await sup.page.getByText('Alertas abertos').first().waitFor({ timeout: 30000 });
          });
          out.alerts = (await sup.page.getByText('Alertas abertos').first().locator('..').innerText()).replace(/\s+/g, ' ').slice(0, 120);
          out.alertsShot = await shot(sup.page, 'inteligencia-alertas');
          await sup.page.goto(base + '/estoque/inteligencia?aba=%22reposicao%22');
          await sup.page.getByRole('heading', { name: REPL_HEADING }).waitFor({ timeout: 60000 });
          if (!(await sup.page.getByText(/O BIOMIE não cria pedido de compra no Omie/).count()))
            throw new Error('aviso de reposição consultiva ausente');
          out.replenishment = (await sup.page.getByRole('button', { name: /^Comprar/ }).first().innerText()).replace(/\s+/g, ' ').slice(0, 120);
          const define = sup.page.getByRole('button', { name: 'Definir prazo' });
          if (await define.count()) {
            await define.click();
            await sup.page.getByRole('dialog').getByText('Parâmetro de reposição').waitFor({ timeout: 30000 });
            const save = sup.page.getByRole('dialog').getByRole('button', { name: 'Salvar' });
            if (await save.isEnabled()) throw new Error('salvaria prazo sem prazo e justificativa');
            await sup.page.getByRole('dialog').getByRole('button', { name: 'Cancelar' }).click();
            out.dialog = 'abre e não salva sem prazo e justificativa';
          } else if (await sup.page.getByRole('link', { name: 'Fornecedores e prazos' }).count()) {
            out.dialog = 'prazos por fornecedor (Fornecedores e prazos)';
            if (!(await sup.page.getByRole('heading', { name: 'Prazos de entrega e política de reposição' }).count()))
              throw new Error('bloco da política de reposição ausente');
          } else out.dialog = 'escolha uma empresa para definir (filtro em todas)';
          out.replenishmentShot = await shot(sup.page, 'inteligencia-reposicao');
          await sup.page.goto(base + '/estoque/inteligencia?aba=%22grupo%22');
          await sup.page.getByText(/Movimentação entre CNPJs pode exigir nota fiscal/).first().waitFor({ timeout: 60000 });
          out.group = (await sup.page.getByText(/ite(m|ns) · página|Nenhuma oportunidade/).first().innerText()).slice(0, 120);
          out.groupShot = await shot(sup.page, 'inteligencia-grupo');
          if (await sup.page.getByText('Não foi possível carregar o estoque').count()) throw new Error('falha numa aba');
          return out;
        });
        await step('super: inteligência — matriz risco × impacto', async () => {
          await sup.page.goto(base + '/estoque/inteligencia');
          await sup.page.getByText(/produtos? · página/).waitFor({ timeout: 60000 });
          const heading = sup.page.getByRole('heading', { name: 'Risco × impacto financeiro' });
          if (!(await heading.count())) return { matrix: 'sem produtos com capital e prioridade' };
          await heading.scrollIntoViewIfNeeded();
          return { matrix: 'ok', shot: await shot(sup.page, 'inteligencia-matriz', false) };
        });
        await step('super: simulação — resultado comercial e base de preço', async () => {
          await sup.page.goto(base + '/estoque/simulacao');
          await sup.page.getByRole('heading', { name: 'Resultado comercial do cenário' }).waitFor({ timeout: 60000 });
          await sup.page.getByRole('group', { name: 'Descontos prontos' }).getByRole('button', { name: '15%' }).click();
          const result = (await sup.page.getByText('Resultado bruto estimado').first().locator('..').innerText()).replace(/\s+/g, ' ').slice(0, 160);
          if (!(await sup.page.getByText(/Receita potencial não é venda garantida/).count()))
            throw new Error('aviso de limitação da simulação ausente');
          await sup.page.getByRole('heading', { name: 'Resultado comercial do cenário' }).scrollIntoViewIfNeeded();
          return { result, shot: await shot(sup.page, 'simulacao-comercial', false) };
        });
        await step('super: inteligência — Pareto de uma empresa', async () => {
          await sup.page.goto(base + '/estoque/inteligencia');
          await sup.page.getByRole('radiogroup', { name: 'Empresas do estoque' }).getByRole('radio').first().click();
          await sup.page.getByRole('heading', { name: /Pareto do faturamento/ }).waitFor({ timeout: 60000 });
          const foot = (await sup.page.getByText(/^Curva A: .* produtos até/).first().innerText()).slice(0, 220);
          await sup.page.getByRole('heading', { name: /Pareto do faturamento/ }).scrollIntoViewIfNeeded();
          return { foot, shot: await shot(sup.page, 'inteligencia-pareto', false) };
        });
      }
    }
    const mobile = await open(browser, 390);

    if (suppliers) {
      await step('super: fornecedores e prazos — página e ficha (sem gravar)', async () => {
        await sup.page.goto(base + '/estoque/fornecedores');
        await sup.page.getByRole('heading', { name: 'Fornecedores e prazos de entrega' }).waitFor({ timeout: 60000 });
        await sup.page.getByText(/Fornecedores no Omie|Escolha uma empresa/).first().waitFor({ timeout: 60000 });
        if (await sup.page.getByText('Não foi possível carregar o estoque').count()) throw new Error('falha na página');
        const out = { shot: await shot(sup.page, 'fornecedores') };
        out.tiles = (await sup.page.locator('#stock-main .panel').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
        // Lista com todos (não só os com estoque) e a ficha do primeiro fornecedor.
        const first = sup.page.locator('#stock-main table tbody tr').first().getByRole('button').first();
        if (!(await first.count())) return { ...out, suppliers: 0 };
        out.firstSupplier = (await first.innerText()).slice(0, 60);
        await first.click();
        const sheet = sup.page.getByRole('dialog');
        await sheet.getByRole('heading', { name: 'Prazo padrão do fornecedor' }).waitFor({ timeout: 60000 });
        await sheet.getByRole('heading', { name: /Produtos vinculados/ }).waitFor({ timeout: 30000 });
        out.historyVisible = (await sheet.getByRole('heading', { name: 'Histórico de alterações' }).count()) > 0;
        out.sheetShot = await shot(sup.page, 'fornecedor-ficha', false);
        const edit = sheet.getByRole('button', { name: /Informar prazo|Alterar/ }).first();
        if (await edit.count()) {
          await edit.click();
          const dialog = sup.page.getByRole('dialog', { name: /Prazo padrão do fornecedor/ });
          await dialog.waitFor({ timeout: 30000 });
          await dialog.getByRole('textbox').first().fill('15');
          if (await dialog.getByRole('button', { name: 'Salvar' }).isEnabled())
            throw new Error('salvaria prazo sem observação');
          await dialog.getByRole('button', { name: 'Cancelar' }).click();
          out.dialog = 'abre e não salva sem observação';
        }
        await sup.page.keyboard.press('Escape');
        return out;
      });
      await step('super: filtro por fornecedor no painel, radar e reposição', async () => {
        await sup.page.goto(base + '/estoque');
        const picker = sup.page.getByRole('combobox', { name: 'Fornecedor' });
        await picker.waitFor({ timeout: 60000 });
        if (await picker.isDisabled()) return { filter: 'desligado (escolha uma empresa ou sem fornecedores)' };
        await picker.click();
        const option = sup.page.getByRole('option').first();
        await option.waitFor({ timeout: 30000 });
        const name = (await option.innerText()).split('\n')[0].slice(0, 60);
        await option.click();
        await sup.page.getByText('Filtrando pelo fornecedor').waitFor({ timeout: 30000 });
        const out = { supplier: name, overviewShot: await shot(sup.page, 'filtro-fornecedor-painel') };
        await sup.page.getByRole('link', { name: 'Inteligência', exact: true }).click();
        await sup.page.getByText(/produtos? · página|Nenhum produto/).first().waitFor({ timeout: 60000 });
        if (!(await sup.page.getByText('Filtrando pelo fornecedor').count())) throw new Error('o filtro sumiu ao trocar de tela');
        out.radarShot = await shot(sup.page, 'filtro-fornecedor-radar');
        await sup.page.goto(base + '/estoque/inteligencia?aba=%22reposicao%22');
        await sup.page.getByRole('heading', { name: REPL_HEADING }).waitFor({ timeout: 60000 });
        if (await sup.page.getByText('Não foi possível carregar o estoque').count()) throw new Error('falha com o filtro');
        await sup.page.getByRole('button', { name: 'Tirar o filtro de fornecedor' }).click().catch(() => {});
        return out;
      });
    }
    await step('super: celular sem rolagem lateral', async () => {
      await login(mobile.page, 'super');
      await mobile.page.goto(base + '/estoque/posicoes');
      await mobile.page.getByText(/Posições de estoque|A primeira leitura/).first().waitFor({ timeout: 45000 });
      const wide = await mobile.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (wide > 2) throw new Error(`página ${wide}px mais larga que a tela`);
    });
    if (intel === '1') await step('super: inteligência no celular sem rolagem lateral', async () => {
      await mobile.page.goto(base + '/estoque/inteligencia');
      await mobile.page.getByText(/produtos? · página/).waitFor({ timeout: 60000 });
      const wide = await mobile.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (wide > 2) throw new Error(`página ${wide}px mais larga que a tela`);
      return { shot: await shot(mobile.page, 'inteligencia-celular') };
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
      if (curves && (await ven.page.getByRole('columnheader', { name: /Faturamento/ }).count()))
        throw new Error('vendedor viu o faturamento da curva');
      return { mode };
    });
    if (intel === '1') await step('vendedor: inteligência sem custo, Pareto ou exportação', async () => {
      await ven.page.goto(base + '/estoque/inteligencia');
      if (mode !== 'on') {
        await ven.page.getByText('ainda não foi liberado para o seu perfil').waitFor({ timeout: 45000 });
        return { mode };
      }
      await ven.page.getByRole('heading', { name: 'Inteligência do estoque' }).waitFor({ timeout: 60000 });
      await ven.page.getByText(/produtos? · página/).waitFor({ timeout: 60000 });
      if (await ven.page.getByText('Capital em estoque').count()) throw new Error('vendedor viu o capital em estoque');
      if (await ven.page.getByRole('columnheader', { name: 'Capital' }).count()) throw new Error('vendedor viu a coluna Capital');
      if (await ven.page.getByRole('heading', { name: /Pareto do faturamento/ }).count()) throw new Error('vendedor viu o Pareto');
      if (await ven.page.getByRole('button', { name: 'Exportar CSV' }).count()) throw new Error('vendedor pode exportar');
      const text = await ven.page.locator('#stock-main').innerText();
      if (/R\$\s?\d/.test(text)) throw new Error('vendedor viu valor em R$');
      if (await ven.page.getByRole('heading', { name: 'Risco × impacto financeiro' }).count()) throw new Error('vendedor viu a matriz (capital)');
      // Fases 3–5: nenhuma aba nova mostra valor em R$ ao vendedor, nem deixa definir prazo.
      const tabs = {};
      for (const [aba, ready] of [['alertas', /Alertas abertos|Nenhum alerta/],
                                  ['reposicao', /Prazos de reposição|Prazos de entrega e política de reposição/],
                                  ['grupo', /Movimentação entre CNPJs/]]) {
        await ven.page.goto(base + `/estoque/inteligencia?aba=%22${aba}%22`);
        await ven.page.getByText(ready).first().waitFor({ timeout: 60000 });
        await ven.page.waitForTimeout(1500);
        const t = await ven.page.locator('#stock-main').innerText();
        if (/R\$\s?\d/.test(t)) throw new Error(`vendedor viu valor em R$ na aba ${aba}`);
        if (await ven.page.getByRole('columnheader', { name: /Custo estimado|Valor a custo/ }).count())
          throw new Error(`vendedor viu coluna de custo na aba ${aba}`);
        if (await ven.page.getByRole('button', { name: 'Definir prazo' }).count()) throw new Error('vendedor pode definir prazo');
        if (await ven.page.getByRole('button', { name: 'Estou ciente' }).count()) throw new Error('vendedor pode dar ciência');
        tabs[aba] = 'sem custo';
      }
      return { mode, tabs, tab: await ven.page.getByRole('link', { name: 'Inteligência', exact: true }).count(),
               shot: await shot(ven.page, 'inteligencia-vendedor') };
    });

    // Comercial (ajuste aprovado em 27/10): previsões e reposições, sem a área de fornecedores e prazos.
    if (suppliers && mode === 'on') await step('vendedor: sem fornecedores e prazos (só previsões e reposições)', async () => {
      await ven.page.goto(base + '/estoque');
      await ven.page.getByRole('link', { name: 'Posições', exact: true }).waitFor({ timeout: 60000 });
      if (await ven.page.getByRole('link', { name: 'Fornecedores e prazos' }).count())
        throw new Error('vendedor vê o menu de fornecedores');
      if (await ven.page.getByRole('combobox', { name: 'Fornecedor' }).count())
        throw new Error('vendedor vê o filtro por fornecedor');
      await ven.page.goto(base + '/estoque/fornecedores');
      await ven.page.getByText(/não fornecedores e prazos de entrega/).first().waitFor({ timeout: 60000 });
      if (await ven.page.locator('#stock-main table').count()) throw new Error('vendedor viu a lista de fornecedores');
      const out = { pageShot: await shot(ven.page, 'fornecedores-vendedor') };
      await ven.page.goto(base + '/estoque/inteligencia?aba=%22reposicao%22');
      await ven.page.getByRole('heading', { name: REPL_HEADING }).waitFor({ timeout: 60000 });
      await ven.page.waitForTimeout(1500);
      if (await ven.page.getByRole('columnheader', { name: 'Fornecedor e prazo' }).count())
        throw new Error('vendedor vê a coluna de fornecedor na reposição');
      if (await ven.page.getByRole('link', { name: 'Fornecedores e prazos' }).count())
        throw new Error('vendedor vê o atalho para fornecedores');
      out.replenishmentShot = await shot(ven.page, 'reposicao-vendedor');
      return out;
    });
  } finally {
    await browser.close();
  }
  const ok = steps.every((s) => s.ok) && !problems.errors.length && !problems.serverFailures.length && !problems.csp.length;
  console.log(JSON.stringify({ ok, mode, steps, problems }, null, 1));
  process.exitCode = ok ? 0 : 1;
})();
