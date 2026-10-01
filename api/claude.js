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
const { sbFetch } = require('./_sb.js');

// Só a equipe usa a IA (28/09/2026): proprietário ou colaborador ATIVO em app_users.
// Cedente e devedor logados eram aceitos só por terem sessão válida.
// Limite diário POR USUÁRIO em app_users.ia_limite_dia (dia de Brasília), contado no
// banco pela RPC ia_uso_registrar (service role; migração 20260928_02). O proprietário
// não tem teto. Colaborador começa em 0 = IA bloqueada (decisão de 01/10/2026); o
// Gustavo libera na tela de usuários, sem mexer em código.
async function lerLimiteColaborador(userId) {
  // Consulta à parte: sem a coluna (migração pendente) o proprietário segue usando a
  // IA e o colaborador fica bloqueado (limite 0).
  try {
    const rows = await sbFetch(`app_users?id=eq.${encodeURIComponent(userId)}&select=ia_limite_dia`, { method: 'GET' });
    const n = Number(Array.isArray(rows) && rows[0] ? rows[0].ia_limite_dia : 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch (e) {
    console.error('[claude proxy] leitura de ia_limite_dia falhou:', e.message);
    return 0;
  }
}

async function autorizarEquipe(user, res) {
  let rows;
  try {
    rows = await sbFetch(`app_users?id=eq.${encodeURIComponent(user.id)}&select=papel,ativo`, { method: 'GET' });
  } catch (e) {
    console.error('[claude proxy] leitura de app_users falhou:', e.message);
    res.status(503).json({ error: { message: 'Não foi possível conferir seu acesso à IA. Tente novamente.' } });
    return null;
  }
  const u = Array.isArray(rows) ? rows[0] : null;
  if (!u || u.ativo === false || !['proprietario', 'colaborador'].includes(u.papel)) {
    res.status(403).json({ error: { message: 'A IA é de uso exclusivo da equipe COBRASQ.' } });
    return null;
  }
  if (u.papel === 'proprietario') return u;
  const limite = await lerLimiteColaborador(user.id);
  if (limite <= 0) {
    res.status(403).json({ error: { message: 'A IA não está liberada para o seu usuário. Se precisar, fale com o Gustavo.' } });
    return null;
  }
  let r;
  try {
    r = await sbFetch('rpc/ia_uso_registrar', { method: 'POST', body: JSON.stringify({ p_user: user.id, p_limite: limite }) });
  } catch (e) {
    // Sem a contagem, fecha (fail-closed): melhor negar do que liberar sem teto.
    console.error('[claude proxy] ia_uso_registrar falhou:', e.message);
    res.status(503).json({ error: { message: 'Não foi possível registrar o uso da IA. Tente novamente.' } });
    return null;
  }
  if (!r || r.ok !== true) {
    res.status(429).json({ error: { message: `Limite diário da IA atingido (${limite} pedidos). Volta amanhã; se precisar antes, fale com o Gustavo.` } });
    return null;
  }
  return u;
}

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

  if (!(await autorizarEquipe(user, res))) return;

  const version = req.headers['anthropic-version'] || '2023-06-01';

  // A Anthropic responde 429 (rate limit) ou 529 (overloaded_error) em picos de
  // demanda — condição transitória, some em segundos. Retry com backoff aqui
  // evita que todo pico vire um "Overloaded" cru na tela de quem estiver usando
  // qualquer uma das telas que chamam este proxy (repasses IA, chat, etc.).
  const RETRY_STATUSES = new Set([429, 500, 502, 503, 529]);
  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = [500, 1500];

  let data, status;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
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
      status = upstream.status;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    } catch (err) {
      console.error('[claude proxy] erro upstream:', err.message);
      status = 502;
      data = { error: { message: 'Serviço de IA temporariamente indisponível. Tente novamente.' } };
    }
    const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
    if (!RETRY_STATUSES.has(status) || isLastAttempt) break;
    console.warn(`[claude proxy] status ${status}, tentativa ${attempt + 1}/${MAX_ATTEMPTS}, retry em ${BACKOFF_MS[attempt]}ms`);
    await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
  }

  if (RETRY_STATUSES.has(status)) {
    data = { error: { message: 'IA sobrecarregada no momento. Tentamos algumas vezes automaticamente — tente de novo em instantes.' } };
  }
  res.status(status).json(data);
};
