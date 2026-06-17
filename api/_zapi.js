// api/_zapi.js — Envio de WhatsApp via Z-API no runtime Vercel. Mesmas env vars de
// api/cron-regua.js (ZAPI_TOKEN / ZAPI_INSTANCE_ID / ZAPI_CLIENT_TOKEN). Observação:
// a edge function enviar-whatsapp usa ZAPI_INSTANCE (sem _ID) no runtime do Supabase
// — são secrets de runtimes diferentes.

async function zapiSendText(phone, message) {
  const token = process.env.ZAPI_TOKEN || '';
  const instance = process.env.ZAPI_INSTANCE_ID || '';
  const clientTk = process.env.ZAPI_CLIENT_TOKEN || '';
  if (!token || !instance) throw new Error('Z-API não configurada');
  const url = `https://api.z-api.io/instances/${encodeURIComponent(instance)}/token/${encodeURIComponent(token)}/send-text`;
  const headers = { 'Content-Type': 'application/json' };
  if (clientTk) headers['Client-Token'] = clientTk;
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ phone: String(phone).replace(/\D/g, ''), message }),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`Z-API HTTP ${r.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

module.exports = { zapiSendText };
