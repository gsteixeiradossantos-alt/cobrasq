// E2E: carrega a extensão REAL no Chromium e roda contra a réplica do Projudi.
// Cenário A: tela de juntada → a extensão deve abrir a lupa, escolher
//            "Manifestação da Parte" e preencher #idTipoDocumento sozinha.
// Cenário B: pré-login em frameset → deve clicar "Advogados, Procuradores, Partes".
const { chromium } = require('playwright');
const path = require('path');

const EXT = require('path').join(__dirname, '..');
const UDD = require('os').tmpdir() + '/cobrasq-e2e-' + Date.now();

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
      resultadoA = `SUCESSO: hid=${estado.hid} desc="${estado.desc}" janelaAindaAberta=${estado.janelaAberta}`;
      // espera mais um pouco pra ver o pós (fechar janela / passo anexos)
      await page.waitForTimeout(4000);
      const dep = await umf().evaluate(() => ({
        janelaAberta: !!document.querySelector('div[id^="window_"]'),
        painel: (document.querySelector('#cobrasq-projudi-panel #cbp-body') || {}).innerText || '',
      })).catch(() => ({}));
      resultadoA += ` | depois: janela=${dep.janelaAberta} painel="${(dep.painel || '').replace(/\n/g, ' | ').slice(0, 160)}"`;
      break;
    }
  }
  console.log('\n=== CENÁRIO A (tipo pela lupa): ' + resultadoA + '\n');
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
