// api/zapsign.js — Proxy server-to-server para a API do ZapSign
// Token em variável de ambiente (ZAPSIGN_TOKEN).
// Browser chama /api/zapsign?path=docs e este handler repassa pra
// https://api.zapsign.com.br/api/v1/{path}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-zapsign-token');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const envToken = process.env.ZAPSIGN_TOKEN || '';
  const token = envToken || req.headers['x-zapsign-token'] || '';
  const pathParam = (req.query.path || '').replace(/^\/+/, '');

  if (!envToken && req.headers['x-zapsign-token']) {
    console.warn('[zapsign proxy] ZAPSIGN_TOKEN não configurada. Usando credencial do header (inseguro).');
  }

  if (!token) {
    return res.status(500).json({
      error: 'ZAPSIGN_TOKEN não configurada no servidor.',
      hint: 'Defina a variável de ambiente ZAPSIGN_TOKEN no painel da Vercel.'
    });
  }
  if (!pathParam) {
    return res.status(400).json({ error: 'query param ?path= ausente' });
  }

  const forwardQuery = { ...req.query };
  delete forwardQuery.path;
  const qs = new URLSearchParams(forwardQuery).toString();
  const upstreamUrl = `https://api.zapsign.com.br/api/v1/${pathParam}${qs ? '?' + qs : ''}`;

  try {
    const fetchOpts = {
      method: req.method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };

    if (!['GET', 'DELETE', 'HEAD'].includes(req.method) && req.body) {
      fetchOpts.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const upstream = await fetch(upstreamUrl, fetchOpts);
    const text = await upstream.text();

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
};
