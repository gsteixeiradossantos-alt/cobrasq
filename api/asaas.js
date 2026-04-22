// api/asaas.js — Proxy server-to-server para a API do Asaas
// Resolve o bloqueio de CORS da Asaas para chamadas diretas do browser.
// O browser chama /api/asaas?path=finance/balance e este handler
// repassa a requisição para api.asaas.com/v3 no lado do servidor.

module.exports = async function handler(req, res) {
  // CORS: permite chamadas da própria origem Vercel
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-asaas-key, x-asaas-env');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const asaasKey = req.headers['x-asaas-key'] || '';
  const asaasEnv = req.headers['x-asaas-env'] || 'sandbox';
  const pathParam = (req.query.path || '').replace(/^\/+/, '');

  if (!asaasKey) {
    return res.status(400).json({ error: 'x-asaas-key header ausente' });
  }
  if (!pathParam) {
    return res.status(400).json({ error: 'query param ?path= ausente' });
  }

  const base = asaasEnv === 'production'
    ? 'https://www.asaas.com/api/v3'
    : 'https://sandbox.asaas.com/api/v3';

  // Repassa todos os query params exceto `path`
  const forwardQuery = { ...req.query };
  delete forwardQuery.path;
  const qs = new URLSearchParams(forwardQuery).toString();
  const upstreamUrl = `${base}/${pathParam}${qs ? '?' + qs : ''}`;

  try {
    const fetchOpts = {
      method: req.method,
      headers: {
        'access_token': asaasKey,
        'Content-Type': 'application/json',
        'User-Agent': 'COBRASQ-Proxy/1.0',
      },
    };

    if (!['GET', 'DELETE', 'HEAD'].includes(req.method) && req.body) {
      fetchOpts.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(upstreamUrl, fetchOpts);
    const text = await upstream.text();

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    // Repassa o status code do Asaas
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message, upstream: upstreamUrl });
  }
};
