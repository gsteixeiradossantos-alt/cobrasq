// api/claude.js — Proxy server-to-server para a API da Anthropic (Claude)
// Mantém a chave (ANTHROPIC_API_KEY) FORA do browser. O front faz
//   POST /api/claude  com corpo { model, max_tokens, messages, system?, ... }
// e este handler repassa para https://api.anthropic.com/v1/messages,
// injetando o x-api-key a partir da variável de ambiente do servidor.
//
// Antes (F-02): o browser chamava a Anthropic direto, com a chave em
// DB.config.claudeApiKey (localStorage) + header
// 'anthropic-dangerous-direct-browser-access'. Qualquer usuário extraía a
// chave e bilhava a conta; além de PII saindo do front. Este proxy fecha isso.
//
// Onda 1b: exige login Supabase (requireUser) — antes qualquer requisição
// anônima da internet usava a conta Anthropic do escritório como proxy grátis.
// O fallback de chave via header x-api-key foi removido (a env já está ativa).
//
// A resposta upstream é repassada como está (mesma forma { content:[...], error? })
// para que os call sites no front continuem funcionando sem mudança de parsing.

const { requireUser, applyCors } = require('./_auth.js');

module.exports = async function handler(req, res) {
  applyCors(req, res, { methods: 'POST, OPTIONS' });

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Use POST.' } });
  }

  const user = await requireUser(req, res);
  if (!user) return;

  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    return res.status(500).json({
      error: { message: 'IA indisponível: ANTHROPIC_API_KEY não configurada no servidor.' },
      hint: 'Defina a variável de ambiente ANTHROPIC_API_KEY no painel da Vercel.'
    });
  }

  // Corpo: aceita objeto (Vercel já faz parse) ou string.
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: { message: 'corpo inválido: "messages" ausente.' } });
  }

  // P2 (auditoria 2026-06) — limita abuso de custo: só modelos Claude e teto de tokens.
  // Qualquer usuário logado chama este proxy; sem teto, dava pra esgotar a conta.
  if (typeof body.model !== 'string' || !/^claude-/.test(body.model)) {
    return res.status(400).json({ error: { message: 'modelo inválido: use um modelo "claude-*".' } });
  }
  const MAX_TOKENS_CEILING = 16000;
  if (!Number.isFinite(body.max_tokens) || body.max_tokens <= 0 || body.max_tokens > MAX_TOKENS_CEILING) {
    body.max_tokens = Math.min(Number(body.max_tokens) > 0 ? Number(body.max_tokens) : 4096, MAX_TOKENS_CEILING);
  }

  const version = req.headers['anthropic-version'] || '2023-06-01';

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': version,
      },
      body: JSON.stringify(body),
    });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('[claude proxy] erro upstream:', err.message);
    res.status(502).json({ error: { message: 'Serviço de IA temporariamente indisponível. Tente novamente.' } });
  }
};
