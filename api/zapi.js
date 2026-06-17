// api/zapi.js — Proxy server-to-server para a Z-API (WhatsApp)
// Mantém token + instanceId em variáveis de ambiente no servidor.
// O browser chama /api/zapi?path=send-text e este handler repassa para
// https://api.z-api.io/instances/{INSTANCE}/token/{TOKEN}/{path}
// Onda 1b: exige login Supabase — antes qualquer requisição anônima usava o
// WhatsApp do escritório (envio em massa, leitura de conversas).

const { requireUser, applyCors } = require('./_auth.js');

module.exports = async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const user = await requireUser(req, res);
  if (!user) return;

  // Credenciais SÓ via env vars (gestor confirmou ZAPI_TOKEN/ZAPI_INSTANCE_ID no Vercel).
  const token       = process.env.ZAPI_TOKEN || '';
  const instanceId  = process.env.ZAPI_INSTANCE_ID || '';
  const clientToken = process.env.ZAPI_CLIENT_TOKEN || '';
  const pathParam   = (req.query.path || '').replace(/^\/+/, '');

  if (!token || !instanceId) {
    return res.status(500).json({
      error: 'Z-API não configurada no servidor.',
      hint: 'Defina ZAPI_TOKEN e ZAPI_INSTANCE_ID (e opcionalmente ZAPI_CLIENT_TOKEN) nas variáveis de ambiente da Vercel.'
    });
  }
  if (!pathParam) {
    return res.status(400).json({ error: 'query param ?path= ausente' });
  }
  // P3 (auditoria 2026-06) — só caracteres de path esperados; bloqueia traversal.
  if (pathParam.includes('..') || !/^[A-Za-z0-9/_.-]+$/.test(pathParam)) {
    return res.status(400).json({ error: 'path inválido' });
  }

  const forwardQuery = { ...req.query };
  delete forwardQuery.path;
  const qs = new URLSearchParams(forwardQuery).toString();
  const upstreamUrl = `https://api.z-api.io/instances/${encodeURIComponent(instanceId)}/token/${encodeURIComponent(token)}/${pathParam}${qs ? '?' + qs : ''}`;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (clientToken) headers['Client-Token'] = clientToken;

    const fetchOpts = { method: req.method, headers };

    if (!['GET', 'DELETE', 'HEAD'].includes(req.method) && req.body) {
      fetchOpts.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const upstream = await fetch(upstreamUrl, fetchOpts);
    const text = await upstream.text();

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('[zapi proxy] erro upstream:', err.message);
    res.status(502).json({ error: 'Falha ao conectar à Z-API. Tente novamente.' });
  }
};
