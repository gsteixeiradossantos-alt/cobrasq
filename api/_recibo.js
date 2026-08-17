// api/_recibo.js — Gera o RECIBO DE PAGAMENTO em PDF no padrão da marca (timbrado
// Marinho/Champagne), reaproveitando o mesmo HTML que a Bia já usa em
// supabase/functions/bia-atendimento/index.ts (gerarReciboHtml) quando o devedor pede o
// comprovante manualmente. Aqui é a versão Node (runtime Vercel), usada pelo envio
// PROATIVO — disparado por api/_processar-recebimento.js quando o Asaas confirma o
// pagamento — em vez do reativo (Bia respondendo "já paguei"/"quer_comprovante").
//
// Rende via o mesmo endpoint /api/gerar-pdf (Chrome headless) que o resto do app usa
// para documentos com identidade visual — sem isso o PDF sairia sem as Google Fonts
// (Fraunces/Instrument Serif/JetBrains Mono) que dão a cara da marca.

function escapeHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function fmtData(d) { const s = String(d || '').slice(0, 10); const p = s.split('-'); return (p.length === 3) ? `${p[2]}/${p[1]}/${p[0]}` : s; }

function dataExtenso(iso) {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-');
  const meses = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const mi = parseInt(m, 10) - 1;
  if (!y || isNaN(mi) || !meses[mi]) return fmtData(iso);
  return `${parseInt(d, 10)} de ${meses[mi]} de ${y}`;
}

// Valor por extenso em reais (0 a milhões, com centavos) — mesma lógica da Bia.
function extensoReais(v) {
  v = Math.round((Number(v) || 0) * 100) / 100;
  const inteiro = Math.floor(v), cent = Math.round((v - inteiro) * 100);
  const u = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
  const dez = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
  const cem = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
  const ate999 = (n) => {
    if (n === 0) return ''; if (n === 100) return 'cem';
    let s = ''; const c = Math.floor(n / 100), r = n % 100;
    if (c) s += cem[c];
    if (r) { if (s) s += ' e '; if (r < 20) s += u[r]; else { const dd = Math.floor(r / 10), un = r % 10; s += dez[dd] + (un ? ' e ' + u[un] : ''); } }
    return s;
  };
  const grupo = (n) => {
    if (n === 0) return 'zero';
    const mi = Math.floor(n / 1000000), ml = Math.floor((n % 1000000) / 1000), r = n % 1000; const p = [];
    if (mi) p.push(ate999(mi) + (mi === 1 ? ' milhão' : ' milhões'));
    if (ml) p.push(ml === 1 ? 'mil' : ate999(ml) + ' mil');
    if (r) p.push(ate999(r));
    return p.join(' e ');
  };
  let s = inteiro === 1 ? 'um real' : grupo(inteiro) + ' reais';
  if (cent) s += ' e ' + (cent === 1 ? 'um centavo' : ate999(cent) + ' centavos');
  return s;
}

// HTML do recibo — mesmo template visual usado pela Bia (timbrado-branco-azul).
function gerarReciboHtml(d) {
  const formaTxt = d.forma ? `, paga via ${d.forma}` : '';
  const dataPagTxt = d.dataISO ? ` em ${fmtData(d.dataISO)}` : '';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400&family=Great+Vibes&family=Instrument+Serif:ital@0;1&family=Inter+Tight:wght@400;500&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<style>
@page{size:210mm 297mm;margin:0;}
*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{width:210mm;height:297mm;background:#fff;font-family:'Inter Tight',sans-serif;color:#0A1530;}
.band{background:#0A1530;padding:34px 70px 30px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #C9A961;}
.lk{display:flex;align-items:center;gap:16px;}
.dot{width:34px;height:34px;border-radius:50%;background:#C9A961;}
.wm{font-family:'Fraunces',serif;font-weight:300;font-size:28px;color:#EFEAD9;}
.wm i{color:#C9A961;font-style:normal;}
.meta{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.13em;text-transform:uppercase;color:#B7B2A2;text-align:right;line-height:2;}
.inner{padding:54px 70px;}
.title{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:34px;}
.kicker{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.28em;text-transform:uppercase;color:#B08D57;margin-bottom:6px;}
.t{font-family:'Fraunces',serif;font-weight:300;font-size:54px;letter-spacing:-0.02em;line-height:1;}
.num{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#8a8577;}
.vbox{display:flex;justify-content:space-between;align-items:baseline;border:0.5px solid #C9A961;background:rgba(201,169,97,0.07);padding:24px 28px;margin-bottom:38px;}
.vl{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#8a8577;}
.vv{font-family:'Fraunces',serif;font-weight:300;font-size:44px;}
.decl{font-family:'Instrument Serif',serif;font-size:20px;line-height:1.7;margin-bottom:16px;}
.decl b{font-family:'Inter Tight',sans-serif;font-weight:400;font-size:17px;}
.decl i{font-style:italic;}
.pd{font-family:'Instrument Serif',serif;font-size:17px;margin-top:26px;}
.sign{margin-top:52px;}
.sign .rub{font-family:'Great Vibes',cursive;font-size:40px;color:#182252;line-height:1;margin-bottom:-6px;}
.sign .line{width:240px;border-top:0.5px solid #0A1530;opacity:0.55;margin-bottom:10px;}
.sign .nm{font-family:'Fraunces',serif;font-weight:300;font-size:23px;color:#0A1530;}
.sign .rl{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.13em;text-transform:uppercase;color:#8a8577;margin-top:5px;}
.foot{position:absolute;bottom:44px;left:70px;right:70px;display:flex;justify-content:space-between;padding-top:18px;border-top:0.5px solid #e6e1d3;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.13em;text-transform:uppercase;color:#8a8577;}
</style></head><body>
<div class="band"><div class="lk"><span class="dot"></span><span class="wm">cobrasq<i>.</i></span></div>
<div class="meta">COBRASQ Recuperadora de Crédito e Cobrança Ltda.<br/>CNPJ 34.626.848/0001-42<br/>Dois Vizinhos · PR · cobrasq.com.br</div></div>
<div class="inner">
  <div class="title"><div><div class="kicker">Comprovante de pagamento</div><div class="t">Recibo</div></div><div class="num">${escapeHtml(d.num)}</div></div>
  <div class="vbox"><span class="vl">Valor recebido</span><span class="vv">R$ ${escapeHtml(d.valorFmt)}</span></div>
  <p class="decl">Recebemos de <b>${escapeHtml(d.nome)}</b> a importância de <b>R$ ${escapeHtml(d.valorFmt)}</b> (<i>${escapeHtml(extensoReais(d.valorNum))}</i>), referente a uma parcela do seu acordo${formaTxt}${dataPagTxt}.</p>
  <p class="decl">Este documento serve como comprovante de pagamento da referida parcela junto à COBRASQ.</p>
  <div class="pd">Dois Vizinhos/PR, ${dataExtenso(d.dataISO)}.</div>
  <div class="sign"><div class="rub">Gustavo Teixeira</div><div class="line"></div><div class="nm">Gustavo Teixeira</div><div class="rl">Proprietário · COBRASQ</div></div>
</div>
<div class="foot"><span>contato@cobrasq.com.br · (46) 98822-6533</span><span>cobrasq.com.br · @ccobrasq</span></div>
</body></html>`;
}

// Gera o PDF (base64) chamando /api/gerar-pdf (server-to-server, x-emit-secret) — mesmo
// endpoint/segredo usado pela Bia. Best-effort: devolve '' em qualquer falha (cold start
// do Chrome, timeout etc.) — quem chama decide o que fazer sem attachment.
// Timeout de 50s, não 28s: /api/gerar-pdf é servido por api/automacao.js, que tem
// maxDuration 60 no vercel.json. Cortar em 28s abortava do lado de cá enquanto o
// endpoint ainda tinha 32s de orçamento — e o cold start sozinho já come boa parte
// disso (baixa o pack do Chromium, ~69 MB, extrai e sobe o browser). Foi o que
// aconteceu no recebimento do Jean Carlos em 17/08/2026: o recibo não saiu e o
// devedor recebeu o link público do Asaas no lugar.
//
// Uma segunda tentativa cobre justamente o cold start: na primeira o binário fica
// em cache no /tmp da função, e a repetição costuma responder em poucos segundos.
async function gerarReciboPdfBase64(d) {
  const base = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  const secret = process.env.EMIT_ACORDO_SECRET;
  if (!base || !secret) { console.warn('[recibo] APP_BASE_URL/EMIT_ACORDO_SECRET ausentes'); return ''; }
  const html = gerarReciboHtml(d);
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const r = await fetch(base + '/api/gerar-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-emit-secret': secret },
        body: JSON.stringify({ html }),
        signal: AbortSignal.timeout(50000),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j && typeof j.base64 === 'string' && j.base64) return j.base64;
      console.warn(`[recibo] gerar-pdf tentativa ${tentativa}: HTTP ${r.status}`, j && j.error);
    } catch (e) {
      console.warn(`[recibo] gerar-pdf tentativa ${tentativa}:`, e.message);
    }
  }
  return '';
}

function formaPagamento(billingType) {
  const bt = String(billingType || '').toUpperCase();
  if (bt === 'PIX') return 'Pix';
  if (bt === 'BOLETO') return 'boleto';
  if (bt === 'CREDIT_CARD' || bt === 'DEBIT_CARD' || bt === 'CARTAO') return 'cartão';
  return '';
}

module.exports = { gerarReciboHtml, gerarReciboPdfBase64, formaPagamento };
