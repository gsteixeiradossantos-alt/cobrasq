// api/_comprovante-pdf.js — Comprovante de repasse ao credor, em PDF, feito pela COBRASQ.
//
// Por que não usar o comprovante do Asaas: `transactionReceiptUrl` NÃO é um arquivo, é
// uma PÁGINA (`content-type: text/html`). Em 17/08/2026 o primeiro repasse real saiu com
// essa página anexada no WhatsApp com o nome ".pdf" — o credor recebeu um arquivo que não
// abre. O link também é do Asaas: se expirar ou mudar, o comprovante some, e a COBRASQ
// precisa poder reapresentá-lo meses depois.
//
// Aqui o documento é da COBRASQ, com os dados da transferência, e o link do Asaas entra
// como referência de origem — não como o comprovante em si.
//
// Mesmo pipeline do recibo: HTML → /api/gerar-pdf (Chromium headless) → base64.
// Best-effort: devolve '' em qualquer falha. O PIX já saiu quando isto roda; falhar aqui
// não pode derrubar o repasse.

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtBRL(v) {
  return (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtData(d) {
  const s = String(d || '').slice(0, 10); const p = s.split('-');
  return (p.length === 3) ? `${p[2]}/${p[1]}/${p[0]}` : s;
}
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function dataExtenso(iso) {
  const s = String(iso || '').slice(0, 10).split('-');
  if (s.length !== 3) return '';
  return `${Number(s[2])} de ${MESES[Number(s[1]) - 1]} de ${s[0]}`;
}
// Mascara a chave PIX: o comprovante circula por WhatsApp e pode ser reencaminhado.
// Mostra só o suficiente para o credor reconhecer a própria chave.
function mascararChave(k) {
  const s = String(k || '').trim();
  if (!s) return '—';
  if (s.length <= 6) return s;
  return `${s.slice(0, 3)}${'•'.repeat(Math.min(8, s.length - 6))}${s.slice(-3)}`;
}

function comprovanteHtml(d) {
  const linhas = [
    ['Credor', d.credorNome],
    ['Devedor', d.devedor],
    d.parcela ? ['Parcela', `n. ${d.parcela}`] : null,
    ['Chave PIX de destino', mascararChave(d.chavePix)],
    ['Data da transferência', fmtData(d.dataISO)],
    ['Identificador Asaas', d.transferId || '—'],
  ].filter(Boolean);

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400&family=Instrument+Serif&family=Inter+Tight:wght@400;500&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
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
.vbox{display:flex;justify-content:space-between;align-items:baseline;border:0.5px solid #C9A961;background:rgba(201,169,97,0.07);padding:24px 28px;margin-bottom:34px;}
.vl{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#8a8577;}
.vv{font-family:'Fraunces',serif;font-weight:300;font-size:44px;}
.decl{font-family:'Instrument Serif',serif;font-size:19px;line-height:1.7;margin-bottom:30px;}
.decl b{font-family:'Inter Tight',sans-serif;font-weight:500;font-size:16px;}
table{width:100%;border-collapse:collapse;margin-bottom:30px;}
td{padding:11px 0;border-bottom:0.5px solid #eae5d8;font-size:14px;vertical-align:top;}
td.k{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:0.14em;text-transform:uppercase;color:#8a8577;width:42%;padding-top:14px;}
td.v{text-align:right;font-weight:500;}
td.v.mono{font-family:'JetBrains Mono',monospace;font-size:11.5px;font-weight:400;color:#5a5f66;}
.pd{font-family:'Instrument Serif',serif;font-size:17px;}
.foot{position:absolute;bottom:44px;left:70px;right:70px;display:flex;justify-content:space-between;padding-top:18px;border-top:0.5px solid #e6e1d3;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.13em;text-transform:uppercase;color:#8a8577;}
</style></head><body>
<div class="band"><div class="lk"><span class="dot"></span><span class="wm">cobrasq<i>.</i></span></div>
<div class="meta">COBRASQ Recuperadora de Crédito e Cobrança Ltda.<br/>CNPJ 34.626.848/0001-42<br/>Dois Vizinhos · PR · cobrasq.com.br</div></div>
<div class="inner">
  <div class="title"><div><div class="kicker">Transferência PIX ao credor</div><div class="t">Comprovante<br/>de repasse</div></div></div>
  <div class="vbox"><span class="vl">Valor repassado</span><span class="vv">R$ ${escapeHtml(fmtBRL(d.valor))}</span></div>
  <p class="decl">A <b>COBRASQ Recuperadora de Crédito e Cobrança Ltda.</b> repassou a <b>${escapeHtml(d.credorNome)}</b> a importância de <b>R$ ${escapeHtml(fmtBRL(d.valor))}</b>, referente ao pagamento realizado por <b>${escapeHtml(d.devedor)}</b>${d.parcela ? `, parcela n. ${escapeHtml(String(d.parcela))}` : ''}.</p>
  <table>${linhas.map(([k, v]) => `<tr><td class="k">${escapeHtml(k)}</td><td class="v${/Identificador|Chave/.test(k) ? ' mono' : ''}">${escapeHtml(v)}</td></tr>`).join('')}</table>
  <div class="pd">Dois Vizinhos/PR, ${dataExtenso(d.dataISO)}.</div>
</div>
<div class="foot"><span>contato@cobrasq.com.br · (46) 98822-6533</span><span>cobrasq.com.br · @ccobrasq</span></div>
</body></html>`;
}

// Devolve base64 do PDF, ou '' se não deu. Nunca lança.
async function gerarComprovanteRepassePdf(d) {
  const base = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  const secret = process.env.EMIT_ACORDO_SECRET;
  if (!base || !secret) { console.warn('[comprovante-pdf] APP_BASE_URL/EMIT_ACORDO_SECRET ausentes'); return ''; }
  try {
    const r = await fetch(base + '/api/gerar-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-emit-secret': secret },
      body: JSON.stringify({ html: comprovanteHtml(d) }),
      signal: AbortSignal.timeout(28000),
    });
    const j = await r.json().catch(() => null);
    return (r.ok && j && typeof j.base64 === 'string') ? j.base64 : '';
  } catch (e) {
    console.warn('[comprovante-pdf] erro:', e.message);
    return '';
  }
}

module.exports = { gerarComprovanteRepassePdf, comprovanteHtml };
