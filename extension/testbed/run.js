// E2E: carrega a extensão REAL no Chromium e roda contra a réplica do Projudi.
// Cenário A: tela de juntada → a extensão deve abrir a lupa, escolher
//            "Manifestação da Parte" e preencher #idTipoDocumento sozinha.
// Cenário B: pré-login em frameset → deve clicar "Advogados, Procuradores, Partes".
const { chromium } = require('playwright');
const path = require('path');

const EXT = '/home/user/cobrasq-faturamento/extension';
const UDD = '/tmp/claude-0/-home-user-cobrasq-faturamento/bf393b4d-f61d-5c07-8c08-612a2d9ed228/scratchpad/testbed/udd-' + Date.now();

const CASO = {
  id: 'teste-e2e-1', sistema: 'projudi', status: 'rodando', motivo: null,
  numero_processo: '0001381-69.2026.8.16.0209', tipo_peticao: 'Manifestação da Parte',
  docs: [{ idx: 0, nome: '1. Sisbajud - 0001381-69.2026.8.16.0209.pdf' }],
  abriuLupa: false, abriuUpload: false, uploadFeito: false, fase: null,
};

(async () => {
  const ctx = await chromium.launchPersistentContext(UDD, {
    // headless:true usaria o headless_shell (sem suporte a extensões);
    // headless:false + --headless=new roda o Chromium completo sem display.
    headless: false,
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--host-resolver-rules=MAP projudi.tjpr.jus.br 127.0.0.1',
      '--ignore-certificate-errors',
      '--no-proxy-server',
    ],
  });

  // acha o service worker da extensão (MV3)
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  console.log('extensão carregada, id=' + extId);

  // grava o caso direto no storage (como a Central faria via RUN_CENTRAL)
  await sw.evaluate((caso) => chrome.storage.local.set({ cobrasq_central_caso: caso }), CASO);
  console.log('caso semeado no chrome.storage.local');

  // MOCK do PEDIR_DOC: no real, a aba da Central devolve o PDF. Aqui, um listener
  // no service worker responde com um PDF mínimo válido em base64 — assim testamos
  // a INJEÇÃO do arquivo no input do Projudi de verdade (DataTransfer → input.files).
  await sw.evaluate(() => {
    const PDF_B64 = 'JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2c+PgplbmRvYmoKdHJhaWxlcgo8PC9Sb290IDEgMCBSPj4KJSVFT0Y=';
    chrome.runtime.onMessage.addListener((m, s, send) => {
      if (m && m.type === 'PEDIR_DOC') { send({ ok: true, nome: '1. Sisbajud - 0001381-69.2026.8.16.0209.pdf', base64: PDF_B64 }); return true; }
      return false;
    });
  });
  console.log('mock PEDIR_DOC instalado no SW');

  // ── Cenário A: juntada ─────────────────────────────────────────────────────
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });
  await page.goto('https://projudi.tjpr.jus.br/projudi/', { waitUntil: 'load' });
  console.log('página juntada aberta; aguardando a extensão agir…');

  const umf = () => page.frames().find(f => f.name() === 'userMainFrame');
  let resultadoA = 'TIMEOUT: idTipoDocumento não preencheu em 40s';
  for (let i = 0; i < 80; i++) {
    await page.waitForTimeout(500);
    const f = umf();
    if (!f) continue;
    const estado = await f.evaluate(() => ({
      hid: (document.getElementById('idTipoDocumento') || {}).value || '',
      desc: (document.getElementById('descricaoTipoDocumento') || {}).value || '',
      janelaAberta: !!document.querySelector('div[id^="window_"]'),
      painel: (document.querySelector('#cobrasq-projudi-panel #cbp-body') || {}).innerText || '',
    })).catch(() => null);
    if (!estado) continue;
    if (i % 8 === 0) console.log(`  t=${(i * 0.5).toFixed(0)}s hid="${estado.hid}" janela=${estado.janelaAberta} painel="${(estado.painel || '').replace(/\n/g, ' | ').slice(0, 140)}"`);
    if (estado.hid) {
      resultadoA = `tipo OK (hid=${estado.hid} "${estado.desc}")`;
      break;
    }
  }
  console.log('CENÁRIO A — passo 1 (tipo): ' + resultadoA);

  // passo 2: anexo — espera a linha do PDF aparecer na tabela da tela-mãe e a
  // pausa final "Concluir Movimento / assine".
  let resultadoAnexo = 'TIMEOUT: anexo não concluiu em 40s';
  for (let i = 0; i < 80; i++) {
    await page.waitForTimeout(500);
    const f = umf();
    if (!f) continue;
    const est = await f.evaluate(() => ({
      linhas: document.querySelectorAll('#anexosBody tr').length,
      temPdfNaLista: /\.pdf/i.test((document.getElementById('anexosBody') || {}).textContent || ''),
      uploadAberto: !!document.querySelector('iframe[src*="upload.do"]'),
      fase: null,
      painel: (document.querySelector('#cobrasq-projudi-panel #cbp-body') || {}).innerText || '',
    })).catch(() => null);
    if (!est) continue;
    if (i % 6 === 0) console.log(`  anexo t=${(i * 0.5).toFixed(0)}s linhas=${est.linhas} pdf=${est.temPdfNaLista} upl=${est.uploadAberto} painel="${(est.painel || '').replace(/\n/g, ' | ').slice(0, 120)}"`);
    if (est.temPdfNaLista && /concluir movimento|assine|anexado/i.test(est.painel)) {
      resultadoAnexo = `SUCESSO: PDF na lista + pausa p/ assinar ("${est.painel.replace(/\n/g, ' | ').slice(0, 120)}")`;
      break;
    }
  }
  console.log('\n=== CENÁRIO A completo: ' + resultadoAnexo + '\n');
  await page.screenshot({ path: path.join(__dirname, 'cenarioA.png'), fullPage: true });
  await page.close();

  // ── Cenário B: pré-login em frameset ───────────────────────────────────────
  await sw.evaluate((caso) => chrome.storage.local.set({ cobrasq_central_caso: caso }), CASO);
  const p2 = await ctx.newPage();
  await p2.goto('https://projudi.tjpr.jus.br/projudi/prelogin', { waitUntil: 'load' });
  let resultadoB = 'FALHOU: não clicou no cartão em 15s';
  for (let i = 0; i < 30; i++) {
    await p2.waitForTimeout(500);
    const fr = p2.frames().find(f => f.url().includes('prelogin-conteudo'));
    if (!fr) continue;
    const clicou = await fr.evaluate(() => document.body.getAttribute('data-clicou') || '').catch(() => '');
    if (clicou) { resultadoB = clicou === 'advogado' ? 'SUCESSO: clicou no cartão de advogado' : 'ERRADO: clicou em "' + clicou + '"'; break; }
  }
  console.log('=== CENÁRIO B (pré-login frameset): ' + resultadoB + '\n');
  await p2.screenshot({ path: path.join(__dirname, 'cenarioB.png'), fullPage: true });

  await ctx.close();
  process.exit(0);
})().catch(e => { console.error('ERRO NO RUNNER:', e); process.exit(1); });
