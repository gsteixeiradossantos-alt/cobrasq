// api/asaas.js — Proxy server-to-server para a API do Asaas
// Credencial SÓ via variável de ambiente (ASAAS_API_KEY): a chave nunca vem
// do browser. O fallback por header x-asaas-key foi removido.
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

  // Credencial SÓ via env var (gestor confirmou ASAAS_API_KEY setada no Vercel).
  // O fallback de chave via header x-asaas-key foi removido: chave nunca vem do cliente.
  const asaasKey = process.env.ASAAS_API_KEY || '';
  // x-asaas-env (sandbox|production) não é segredo; mantém fallback por header.
  const asaasEnv = process.env.ASAAS_ENV || req.headers['x-asaas-env'] || 'sandbox';
  const pathParam = (req.query.path || '').replace(/^\/+/, '');

  if (!asaasKey) {
    return res.status(500).json({
      error: 'ASAAS_API_KEY não configurada no servidor.',
      hint: 'Defina a variável de ambiente ASAAS_API_KEY (e opcionalmente ASAAS_ENV=sandbox|production) no painel da Vercel.'
    });
  }
  if (!pathParam) {
    return res.status(400).json({ error: 'query param ?path= ausente' });
  }

  // P1 (AUDITORIA-2026-07) — bloqueia path traversal: sem isto, `?path=./transfers`
  // ou `../transfers` NÃO casa com a denylist abaixo (o prefixo fica `./transfers`),
  // mas o Asaas normaliza a URL e alcança o endpoint bloqueado que move dinheiro.
  if (pathParam.split('/').some((seg) => seg === '.' || seg === '..')) {
    return res.status(403).json({ error: 'Operação não permitida por este endpoint.' });
  }

  // P2 (auditoria 2026-06) — hardening: este proxy é exposto ao browser e usa a
  // chave da conta do escritório. Endpoints que MOVEM DINHEIRO ou alteram a conta
  // não devem ser alcançáveis pelo cliente: o repasse PIX é server-only (api/repassar.js).
  // Denylist por prefixo de recurso (case-insensitive).
  const BLOCKED_PREFIXES = ['transfers', 'pix/transactions', 'anticipations', 'bill', 'mobilePhoneRecharges', 'accounts', 'myAccount', 'transferences'];
  const resource = pathParam.toLowerCase();
  if (BLOCKED_PREFIXES.some((p) => resource === p || resource.startsWith(p + '/') || resource.startsWith(p + '?'))) {
    return res.status(403).json({ error: 'Operação não permitida por este endpoint.' });
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
