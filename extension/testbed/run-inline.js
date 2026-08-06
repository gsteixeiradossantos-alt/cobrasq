const { chromium } = require('playwright');
const EXT = '/home/user/cobrasq-faturamento/extension';
const UDD = require('os').tmpdir() + '/cobrasq-inl-' + Date.now();
const CASO = { id: 'inl', sistema: 'projudi', status: 'rodando', motivo: null,
  numero_processo: '0001381-69.2026.8.16.0209', tipo_peticao: 'Manifestação da Parte',
  docs: [{ idx: 0, nome: 'x.pdf' }], abriuLupa: false, abriuUpload: false, uploadFeito: false, fase: null };
const PDF_B64 = 'JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2c+PgplbmRvYmoKdHJhaWxlcgo8PC9Sb290IDEgMCBSPj4KJSVFT0Y=';
(async () => {
  const ctx = await chromium.launchPersistentContext(UDD, { headless: false,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      '--host-resolver-rules=MAP projudi.tjpr.jus.br 127.0.0.1', '--ignore-certificate-errors', '--no-proxy-server'] });
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  await sw.evaluate((c) => chrome.storage.local.set({ cobrasq_central_caso: c }), CASO);
  await sw.evaluate((B) => { chrome.runtime.onMessage.addListener((m, s, send) => { if (m && m.type === 'PEDIR_DOC') { send({ ok: true, nome: 'x.pdf', base64: B }); return true; } return false; }); }, PDF_B64);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load/.test(m.text())) console.log('[err]', m.text().slice(0, 160)); });
  await page.goto('https://projudi.tjpr.jus.br/projudi/inline', { waitUntil: 'load' });
  const umf = () => page.frames().find(f => f.name() === 'userMainFrame');
  let res = 'TIMEOUT';
  for (let i = 0; i < 70; i++) {
    await page.waitForTimeout(500);
    const f = umf(); if (!f) continue;
    const e = await f.evaluate(() => ({ pdf: /\.pdf/i.test((document.getElementById('anexosBody') || {}).textContent || ''), painel: (document.querySelector('#cobrasq-projudi-panel #cbp-body') || {}).innerText || '' })).catch(() => null);
    if (!e) continue;
    if (i % 8 === 0) console.log(`t=${(i * 0.5).toFixed(0)}s pdf=${e.pdf} painel="${(e.painel || '').replace(/\n/g, ' | ').slice(0, 110)}"`);
    if (e.pdf && /concluir movimento|assine|anexado/i.test(e.painel)) { res = 'SUCESSO: PDF anexado inline + pausa assinar'; break; }
  }
  const fEnd = umf() || page.mainFrame();
  const dbg = await fEnd.evaluate(() => ({
    up: document.getElementById('uploadArea') ? getComputedStyle(document.getElementById('uploadArea')).display : '?',
    fileCount: ((document.getElementById('conteudo') || {}).files || {}).length,
    anex: ((document.getElementById('anexosBody') || {}).textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    painel: (document.querySelector('#cobrasq-projudi-panel #cbp-body') || {}).innerText || '',
  })).catch(e => ({ erro: String(e) }));
  console.log('DBG', JSON.stringify(dbg));
  const st = await sw.evaluate(() => chrome.storage.local.get('cobrasq_central_caso'));
  const cc = st.cobrasq_central_caso || {};
  console.log('ST', JSON.stringify({ status: cc.status, fase: cc.fase, abriuUpload: cc.abriuUpload, uploadFeito: cc.uploadFeito, motivo: (cc.motivo || '').slice(0, 70) }));
  console.log('INLINE: ' + res);
  await ctx.close(); process.exit(0);
})().catch(e => { console.error('ERRO:', e); process.exit(1); });
