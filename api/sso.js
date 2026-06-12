// api/sso.js — Login único faturamento → CRM.
//
// Fluxo: o front (logado) chama GET /api/sso com o Bearer da sessão. Validamos o
// usuário (requireUser) e geramos, via API admin do GoTrue, um magic link de uso
// único para o MESMO e-mail. Devolvemos só o token_hash; o front abre o CRM com
// `#sso_token=<hash>` e o CRM troca o hash por uma sessão própria (verifyOtp).
// Cada app fica com sessão independente — sem compartilhar refresh token (que
// quebraria a sessão de origem pela rotação).
//
// Requer env adicional no Vercel: SUPABASE_SERVICE_ROLE_KEY (server-only).
// Sem ela, responde 501 e o front abre o CRM com login manual (fallback).
const { applyCors, requireUser } = require('./_auth');

module.exports = async (req, res) => {
  applyCors(req, res, { methods: 'GET, OPTIONS' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const user = await requireUser(req, res);
  if (!user) return;
  if (!user.email) return res.status(400).json({ error: 'sessão sem e-mail' });

  const supaUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!supaUrl || !serviceKey) {
    return res.status(501).json({ error: 'SSO indisponível: configure SUPABASE_SERVICE_ROLE_KEY no Vercel.' });
  }

  try {
    const r = await fetch(supaUrl + '/auth/v1/admin/generate_link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': 'Bearer ' + serviceKey,
      },
      body: JSON.stringify({ type: 'magiclink', email: user.email }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[sso] generate_link falhou:', r.status, j?.msg || j?.error || '');
      return res.status(502).json({ error: 'falha ao gerar link de sessão' });
    }
    const tokenHash = j.hashed_token || j?.properties?.hashed_token;
    if (!tokenHash) return res.status(502).json({ error: 'resposta sem token' });
    return res.status(200).json({ token_hash: tokenHash });
  } catch (e) {
    console.error('[sso] exceção:', e?.message || e);
    return res.status(500).json({ error: 'erro interno' });
  }
};
