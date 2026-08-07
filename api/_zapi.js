// api/_zapi.js — Envio de WhatsApp via Z-API no runtime Vercel. Mesmas env vars de
// api/cron-regua.js (ZAPI_TOKEN / ZAPI_INSTANCE_ID / ZAPI_CLIENT_TOKEN). Observação:
// a edge function enviar-whatsapp usa ZAPI_INSTANCE (sem _ID) no runtime do Supabase
// — são secrets de runtimes diferentes.

// Normaliza telefone pro formato que a Z-API espera (DDI 55 + DDD + 9 dígitos,
// 13 dígitos). Achado 2026-08-07 (caso Débora Aparecida Simioni): 17 devedores
// tinham telefone salvo como "0" + "55" + 11 dígitos (14 chars) — um zero de
// discagem sobrando na frente do DDI, que nem replace(/\D/g,'') nem o antigo
// "prefixa 55 se <=11 dígitos" pegavam (14 > 11, não entrava na regra). A Z-API
// rejeitava/ignorava silenciosamente — recibo nunca chegava, sem erro visível.
function normalizePhoneBR(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (/^0(55)\d{11}$/.test(d)) d = d.slice(1);
  if (d && d.length <= 11 && !d.startsWith('55')) d = '55' + d;
  return d;
}

async function zapiSendText(phone, message) {
  const token = process.env.ZAPI_TOKEN || '';
  const instance = process.env.ZAPI_INSTANCE_ID || '';
  const clientTk = process.env.ZAPI_CLIENT_TOKEN || '';
  if (!token || !instance) throw new Error('Z-API não configurada');
  const url = `https://api.z-api.io/instances/${encodeURIComponent(instance)}/token/${encodeURIComponent(token)}/send-text`;
  const headers = { 'Content-Type': 'application/json' };
  if (clientTk) headers['Client-Token'] = clientTk;
  const fone = normalizePhoneBR(phone);
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ phone: fone, message }),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`Z-API HTTP ${r.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

// Envia um PDF (base64) como DOCUMENTO no WhatsApp (Z-API send-document/pdf) — mesmo
// endpoint que supabase/functions/bia-atendimento/index.ts (enviarDocumentoPdf) usa no
// runtime Deno; esta é a versão Node/Vercel. Devolve true/false (best-effort).
async function zapiSendDocumentPdf(phone, base64, fileName) {
  const token = process.env.ZAPI_TOKEN || '';
  const instance = process.env.ZAPI_INSTANCE_ID || '';
  const clientTk = process.env.ZAPI_CLIENT_TOKEN || '';
  if (!token || !instance || !base64) return false;
  const url = `https://api.z-api.io/instances/${encodeURIComponent(instance)}/token/${encodeURIComponent(token)}/send-document/pdf`;
  const headers = { 'Content-Type': 'application/json' };
  if (clientTk) headers['Client-Token'] = clientTk;
  const fone = normalizePhoneBR(phone);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone: fone, document: `data:application/pdf;base64,${base64}`, fileName }),
    });
    const j = await r.json().catch(() => null);
    return !!(r.ok && j && !j.error && (j.messageId || j.id || j.zaapId));
  } catch { return false; }
}

module.exports = { zapiSendText, zapiSendDocumentPdf, normalizePhoneBR };
