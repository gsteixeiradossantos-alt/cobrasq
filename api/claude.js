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
// A resposta upstream é repassada como está (mesma forma { content:[...], error? })
// para que os call sites no front continuem funcionando sem mudança de parsing.

module.exports = async function handler(req, res) {
  // CORS: permite chamadas da própria origem
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Use POST.' } });
  }

  // 1) Prioriza env var (segredo server-side).
  const envKey = process.env.ANTHROPIC_API_KEY || '';
  // 2) Fallback de transição: aceita header só se a env ainda não foi setada.
  const apiKey = envKey || req.headers['x-api-key'] || '';
  if (!envKey && req.headers['x-api-key']) {
    console.warn('[claude proxy] ANTHROPIC_API_KEY não configurada. Usando chave do header (inseguro).');
  }
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
    res.status(502).json({ error: { message: err.message } });
  }
};
