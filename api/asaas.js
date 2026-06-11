// api/asaas.js — Proxy server-to-server para a API do Asaas
// Prioriza credencial em variável de ambiente (ASAAS_API_KEY) para manter
// a chave fora do browser. Mantém fallback por header (backward-compat)
// mas emite warning no console server-side.
// Onda 1b: exige login Supabase — antes qualquer requisição anônima criava/
// alterava/cancelava cobranças na conta Asaas do escritório.

const { requireUser, applyCors } = require('./_auth.js');

module.exports = async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const user = await requireUser(req, res);
  if (!user) return;

  // 1) Prioriza env vars (server-side secret) — não expõe chave no browser
  const envKey = process.env.ASAAS_API_KEY || '';
  const envEnv = process.env.ASAAS_ENV || '';
  // 2) Fallback: aceita header se env não estiver configurada (transição)
  const asaasKey = envKey || req.headers['x-asaas-key'] || '';
  const asaasEnv = envEnv || req.headers['x-asaas-env'] || 'sandbox';
  const pathParam = (req.query.path || '').replace(/^\/+/, '');

  if (!envKey && req.headers['x-asaas-key']) {
    // Avisa (sem expor a chave) que está em modo inseguro
    console.warn('[asaas proxy] ASAAS_API_KEY não configurada. Usando chave do header (inseguro).');
  }

  if (!asaasKey) {
    return res.status(500).json({
      error: 'ASAAS_API_KEY não configurada no servidor.',
      hint: 'Defina a variável de ambiente ASAAS_API_KEY (e opcionalmente ASAAS_ENV=sandbox|production) no painel da Vercel.'
    });
  }
  if (!pathParam) {
    return res.status(400).json({ error: 'query param ?path= ausente' });
  }

  const base = asaasEnv === 'production'
    ? 'https://www.asaas.com/api/v3'
    : 'https://sandbox.asaas.com/api/v3';

  // Repassa query params exceto `path`
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
      fetchOpts.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const upstream = await fetch(upstreamUrl, fetchOpts);
    const text = await upstream.text();

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    res.status(upstream.status).json(data);
  } catch (err) {
    // Não expõe err.message/upstreamUrl cru (vazava topologia e detalhes internos).
    console.error('[asaas proxy] erro upstream:', err.message);
    res.status(502).json({ error: 'Falha ao conectar ao Asaas. Tente novamente.' });
  }
};
