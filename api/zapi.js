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

  // Prioriza env vars
  const envToken    = process.env.ZAPI_TOKEN || '';
  const envInstance = process.env.ZAPI_INSTANCE_ID || '';
  const envClientTk = process.env.ZAPI_CLIENT_TOKEN || '';

  const token       = envToken    || req.headers['x-zapi-token']    || '';
  const instanceId  = envInstance || req.headers['x-zapi-instance'] || '';
  const clientToken = envClientTk || req.headers['x-zapi-client-token'] || '';
  const pathParam   = (req.query.path || '').replace(/^\/+/, '');

  if (!envToken && req.headers['x-zapi-token']) {
    console.warn('[zapi proxy] ZAPI_TOKEN não configurada. Usando credencial do header (inseguro).');
  }

  if (!token || !instanceId) {
    return res.status(500).json({
      error: 'Z-API não configurada no servidor.',
      hint: 'Defina ZAPI_TOKEN e ZAPI_INSTANCE_ID (e opcionalmente ZAPI_CLIENT_TOKEN) nas variáveis de ambiente da Vercel.'
    });
  }
  if (!pathParam) {
    return res.status(400).json({ error: 'query param ?path= ausente' });
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
