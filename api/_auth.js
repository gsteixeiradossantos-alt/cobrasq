// api/_auth.js — Autenticação e CORS compartilhados pelos proxies serverless.
//
// Antes, os proxies (/api/claude, /api/asaas, /api/zapsign, /api/zapi) aceitavam
// requisição ANÔNIMA de qualquer lugar da internet: qualquer terceiro podia usar
// as contas Anthropic/Asaas/ZapSign/Z-API do escritório. Agora todo proxy exige
// o token de sessão do Supabase (header Authorization: Bearer <access_token>),
// validado server-to-server em ${SUPABASE_URL}/auth/v1/user.
//
// Usa as mesmas env vars que api/config.js já expõe (SUPABASE_URL/SUPABASE_ANON_KEY)
// — nenhum segredo novo. A anon key é pública por design; aqui ela só identifica o
// projeto na chamada de validação.

// Domínios autorizados a chamar os proxies de outro origin (CORS). Em produção o
// front é servido do MESMO domínio (same-origin não exige CORS); a lista cobre
// dev local e o domínio canônico. Sem reflexo de origem arbitrária.
const ALLOWED_ORIGINS = new Set([
  'https://painel.cobrasq.com.br',          // domínio canônico (custom)
  'http://localhost:3737',
  'http://127.0.0.1:3737',
  'http://localhost:3000',
]);

function applyCors(req, res, { methods = 'GET, POST, PUT, DELETE, OPTIONS' } = {}) {
  const origin = req.headers.origin || '';
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, x-asaas-key, x-asaas-env, x-zapsign-token, x-zapi-token, x-zapi-instance, x-zapi-client-token');
  }
  // Origin ausente = same-origin ou server-to-server: CORS não se aplica.
}

// Valida a sessão. Retorna o usuário (objeto do GoTrue) ou null — quando null,
// a resposta HTTP já foi enviada (401/5xx): o handler deve apenas dar return.
async function requireUser(req, res) {
  const supaUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anonKey = process.env.SUPABASE_ANON_KEY || '';
  if (!supaUrl || !anonKey) {
    console.error('[auth] SUPABASE_URL/SUPABASE_ANON_KEY não configuradas — proxy fechado (fail-closed).');
    res.status(500).json({ error: 'Autenticação indisponível no servidor. Contate o gestor.' });
    return null;
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ error: 'Não autenticado. Faça login e tente novamente.' });
    return null;
  }

  try {
    const r = await fetch(`${supaUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      res.status(401).json({ error: 'Sessão inválida ou expirada. Faça login novamente.' });
      return null;
    }
    return await r.json();
  } catch (err) {
    console.error('[auth] falha ao validar sessão:', err.message);
    res.status(502).json({ error: 'Não foi possível validar a sessão. Tente novamente.' });
    return null;
  }
}

module.exports = { requireUser, applyCors };
