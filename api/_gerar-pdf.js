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
//
// ⚠️ RUNTIME: o app roda em Node 20 (package.json engines). No Node 22 da Vercel
// (base Amazon Linux 2023) o Chromium do @sparticuz/chromium-min@131 falha ao
// carregar libnss3.so ("error while loading shared libraries: libnss3.so"). O Node
// 20 (base anterior) traz as libs que o binário precisa. NÃO voltar engines p/ 22
// sem revalidar o /api/gerar-pdf, ou o "Gerar PDF" do servidor quebra (o cliente
// cai no Imprimir como rede de segurança, mas perde o 1-clique).

const crypto = require('crypto');
const { requireUser, applyCors } = require('./_auth.js');
const chromium = require('@sparticuz/chromium-min');
const puppeteer = require('puppeteer-core');

// Auth server-to-server (Edge Functions Supabase, ex.: recibo de pagamento da Bia): quando o
// header x-emit-secret bate com EMIT_ACORDO_SECRET, dispensa o login de usuário. Sem isso, o
// endpoint exige sessão Supabase (requireUser), pois o HTML pode conter PII do escritório.
function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// chromium-min NÃO empacota o binário (mantém a função pequena → build confiável
// na Vercel). O binário é baixado da release oficial (versão casada com o pacote)
// no cold start e fica em cache no /tmp. URL precisa bater com a versão instalada.
const CHROMIUM_PACK = 'https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar';

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const s2s = timingSafeEq(req.headers['x-emit-secret'] || '', process.env.EMIT_ACORDO_SECRET || '');
  if (!s2s) {
    const user = await requireUser(req, res);
    if (!user) return;
  }

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
      executablePath: await chromium.executablePath(CHROMIUM_PACK),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    // networkidle0 já aguarda o download das fontes (Google Fonts via <link>),
    // então o page.pdf renderiza com a tipografia correta (validado: a fonte sai certa).
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 25000 });

    // Rodapé DE PÁGINA (footerTemplate) só p/ os documentos do cliente, que sinalizam via
    // <meta name="pdf-footer-band">. Renderiza a faixa escura na BASE de TODA página (o
    // @page do documento reserva a margem inferior). Gotchas do Chromium tratados:
    // font-size explícito no root (o default é ~0) e print-color-adjust p/ o fundo escuro.
    const comRodape = /name=["']pdf-footer-band["']/.test(html);
    const pdfOpts = {
      format: 'A4',
      printBackground: true,      // mantém o timbrado escuro/cores do documento
      preferCSSPageSize: true,    // respeita o @page{size:A4;margin} do documento
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
    };
    if (comRodape) {
      pdfOpts.displayHeaderFooter = true;
      pdfOpts.headerTemplate = '<span style="display:none"></span>';
      pdfOpts.footerTemplate =
        '<div style="width:100%;margin:0;padding:0;font-size:6.8pt;-webkit-print-color-adjust:exact;print-color-adjust:exact;">' +
        '<div style="background:#0A1530;border-top:1.4px solid #C9A961;color:#B9C0CE;' +
        "font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;" +
        'font-size:6.8pt;line-height:1.7;letter-spacing:.06em;text-transform:uppercase;text-align:center;padding:8px 0 9px;">' +
        'cobrasq.com.br&nbsp;·&nbsp;contato@cobrasq.com.br&nbsp;·&nbsp;WhatsApp (46)&nbsp;98822-6533<br>Documento confidencial.' +
        '</div></div>';
    }
    const pdfBuffer = await page.pdf(pdfOpts);

    await browser.close();
    browser = null;

    const base64 = Buffer.from(pdfBuffer).toString('base64');
    if (!base64 || base64.length < 1000) {
      return res.status(500).json({ error: 'PDF gerado vazio' });
    }
    return res.status(200).json({ base64 });
  } catch (e) {
    if (browser) { try { await browser.close(); } catch { /* já encerrando */ } }
    console.error('[gerar-pdf] erro:', e && e.message);
    return res.status(500).json({ error: 'Falha ao gerar PDF no servidor: ' + (e && e.message || 'desconhecido') });
  }
};
