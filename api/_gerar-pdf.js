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
// ⚠️ RUNTIME (2026-08-06): a Vercel passou a rodar as functions sobre Amazon Linux
// 2023, que não traz libnss3.so no SO — o @sparticuz/chromium-min@131 (compilado pra
// AL2, a imagem antiga) quebrava com "error while loading shared libraries:
// libnss3.so". Fix: subiu pra @sparticuz/chromium-min@140 (bundla um pack AL2023 —
// ver release notes/al2023.tar.br do pacote), que já resolve sozinho, sem depender
// da imagem/engines do host. A partir da v137 o pacote também ficou "sem opinião"
// (parou de exportar args/headless/viewport prontos) — daí o args/headless/viewport
// explícitos abaixo, no formato que o próprio README do pacote recomenda agora.
// NÃO trocar a versão do pacote sem também trocar CHROMIUM_PACK (a URL do pack
// remoto — arch-specific desde a v137 — tem que bater com a versão instalada).

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
// Desde a v137 o pack é por arquitetura — Vercel usa x64, daí o sufixo .x64.tar.
const CHROMIUM_PACK = 'https://github.com/Sparticuz/chromium/releases/download/v140.0.0/chromium-v140.0.0-pack.x64.tar';

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
  let url = '';
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    html = body.html || '';
    url = body.url || '';
  } catch { /* corpo inválido cai na validação abaixo */ }

  // Modo URL: abre a PÁGINA e imprime, em vez de renderizar HTML recebido. Existe para o
  // comprovante de repasse — a página do Asaas monta o conteúdo por JavaScript e sai num
  // layout melhor que o PDF estático que eles servem; com setContent o JS não roda (a
  // origem seria about:blank e as chamadas dele seriam cross-origin).
  //
  // ALLOWLIST FECHADA. Aceitar URL arbitrária aqui seria SSRF: este endpoint roda no
  // servidor, com acesso à rede interna da Vercel e a metadata endpoints. Só entra host
  // que a COBRASQ precisa imprimir.
  const HOSTS_PERMITIDOS = ['www.asaas.com', 'asaas.com'];
  if (url) {
    let u = null;
    try { u = new URL(url); } catch { return res.status(400).json({ error: 'url inválida' }); }
    if (u.protocol !== 'https:' || !HOSTS_PERMITIDOS.includes(u.hostname)) {
      return res.status(400).json({ error: 'url não permitida' });
    }
  }

  if (!url && (!html || typeof html !== 'string')) {
    return res.status(400).json({ error: 'informe "html" ou "url"' });
  }
  if (html.length > 6 * 1024 * 1024) {
    return res.status(413).json({ error: 'HTML acima do limite (6 MB)' });
  }

  let browser = null;
  try {
    // args/headless/viewport explícitos: a partir da v137 o pacote parou de exportar
    // defaults prontos (ver comentário no topo do arquivo) — este é o shape que o
    // README do @sparticuz/chromium recomenda para Puppeteer.
    const viewport = { deviceScaleFactor: 1, hasTouch: false, height: 1080, isLandscape: true, isMobile: false, width: 1920 };
    browser = await puppeteer.launch({
      args: await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
      defaultViewport: viewport,
      executablePath: await chromium.executablePath(CHROMIUM_PACK),
      headless: 'shell',
    });

    const page = await browser.newPage();
    // networkidle0 já aguarda o download das fontes (Google Fonts via <link>),
    // então o page.pdf renderiza com a tipografia correta (validado: a fonte sai certa).
    if (url) {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 25000 });
      // A página do Asaas mostra "Aguarde" enquanto busca os dados. Sem esperar o
      // conteúdo real aparecer, o PDF sai com a tela de carregamento.
      await page.waitForFunction(
        () => !/Aguarde/i.test(document.body.innerText) && document.body.innerText.length > 300,
        { timeout: 15000 },
      ).catch(() => { /* segue e imprime o que houver */ });
    } else {
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 25000 });
    }

    // Rodapé DE PÁGINA (footerTemplate) só p/ os documentos do cliente, que sinalizam via
    // <meta name="pdf-footer-band">. Renderiza a faixa escura na BASE de TODA página (o
    // @page do documento reserva a margem inferior). Gotchas do Chromium tratados:
    // font-size explícito no root (o default é ~0) e print-color-adjust p/ o fundo escuro.
    const comRodape = !url && /name=["']pdf-footer-band["']/.test(html);
    // Rodapé RICO (endereço/CNPJ/atendimento em 2 colunas) — só para o Relatório de
    // Andamento (sinalizado via <meta name="pdf-footer-band-rel">). Mantido separado do
    // rodapé genérico acima para não alterar a aparência dos documentos já em produção
    // que usam o pdf-footer-band simples (cessão/procuração/declaração etc.).
    const comRodapeRel = !url && /name=["']pdf-footer-band-rel["']/.test(html);
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
    } else if (comRodapeRel) {
      pdfOpts.displayHeaderFooter = true;
      pdfOpts.headerTemplate = '<span style="display:none"></span>';
      pdfOpts.footerTemplate =
        '<div style="width:100%;margin:0;padding:0 0.7in;font-size:7pt;-webkit-print-color-adjust:exact;print-color-adjust:exact;">' +
        '<div style="background:#0A1530;color:#EFEAD9;border-top:1.4px solid #C9A961;border-radius:0 0 10px 10px;' +
        "font-family:'Inter Tight',ui-sans-serif,-apple-system,sans-serif;" +
        'display:flex;gap:20px;padding:9px 18px 10px;">' +
        '<div style="flex:1;min-width:0;"><div style="font-family:\'JetBrains Mono\',ui-monospace,monospace;font-size:6.2pt;letter-spacing:.14em;text-transform:uppercase;color:#C9A961;margin-bottom:3px;">COBRASQ — Sede</div>' +
        '<div style="font-size:7.2pt;line-height:1.5;opacity:.92;">Av. Rio Grande do Sul, n.º 380, Sala 201, Edifício Mara — Centro, Dois Vizinhos/PR &nbsp;·&nbsp; CNPJ 34.626.848/0001-42</div></div>' +
        '<div style="flex:0 0 auto;max-width:2.3in;text-align:right;"><div style="font-family:\'JetBrains Mono\',ui-monospace,monospace;font-size:6.2pt;letter-spacing:.14em;text-transform:uppercase;color:#C9A961;margin-bottom:3px;">Atendimento</div>' +
        '<div style="font-size:7.2pt;line-height:1.5;opacity:.92;">WhatsApp (46) 98822-6533 &nbsp;·&nbsp; contato@cobrasq.com.br &nbsp;·&nbsp; cobrasq.com.br</div></div>' +
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
