// api/gerar-pdf.js — Gera PDF VETORIAL a partir de HTML, com Chromium headless.
//
// Por quê: os documentos do cliente (cessão/procuração/declaração) eram
// rasterizados no browser pelo html2canvas, que tem bugs de layout (texto
// sobrepondo após <strong> na quebra de linha) e produz PDF "imagem" pesado e
// não-selecionável. Aqui o próprio motor do navegador (o mesmo que renderiza a
// pré-visualização) gera o PDF: layout fiel, texto selecionável, multipágina.
//
// Recebe POST { html } e devolve { base64 } (PDF). O cliente envia esse base64
// ao ZapSign. Exige login Supabase — o HTML contém PII de contratos do escritório.
//
// Dependências (package.json): puppeteer-core + @sparticuz/chromium (binário do
// Chromium empacotado, compatível com o limite de tamanho das funções Vercel).

const { requireUser, applyCors } = require('./_auth.js');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await requireUser(req, res);
  if (!user) return;

  let html = '';
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    html = body.html || '';
  } catch { /* corpo inválido cai na validação abaixo */ }

  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'campo "html" ausente ou inválido' });
  }
  if (html.length > 6 * 1024 * 1024) {
    return res.status(413).json({ error: 'HTML acima do limite (6 MB)' });
  }

  let browser = null;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    // networkidle0 espera as fontes do Google Fonts (<link>) carregarem.
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 25000 });
    try { await page.evaluate(() => (document.fonts && document.fonts.ready) || true); } catch (_) {}

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,      // mantém o timbrado escuro/cores do documento
      preferCSSPageSize: true,    // respeita o @page{size:A4;margin:0} do documento
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
    });

    await browser.close();
    browser = null;

    const base64 = Buffer.from(pdfBuffer).toString('base64');
    if (!base64 || base64.length < 1000) {
      return res.status(500).json({ error: 'PDF gerado vazio' });
    }
    return res.status(200).json({ base64 });
  } catch (e) {
    if (browser) { try { await browser.close(); } catch (_) {} }
    console.error('[gerar-pdf] erro:', e && e.message);
    return res.status(500).json({ error: 'Falha ao gerar PDF no servidor: ' + (e && e.message || 'desconhecido') });
  }
};
