// api/mfa.js — Autenticação em 2 fatores para o Portal Devedor.
// Dois endpoints num só arquivo, diferenciados por ?action=:
//   POST /api/mfa?action=challenge  body: { devId, telefone }
//       Gera código 6 dígitos, salva hash no Supabase, manda via Z-API.
//   POST /api/mfa?action=verify     body: { devId, code }
//       Valida e (on success) marca como consumido.
//
// Requer:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   ZAPI_TOKEN, ZAPI_INSTANCE_ID (+ ZAPI_CLIENT_TOKEN opcional)
//
// Considerações de segurança:
//  - Código expira em 5 minutos.
//  - Máx 5 tentativas, depois invalida.
//  - Armazena apenas SHA-256 do código + salt fixo por projeto.

const crypto = require('crypto');

const SB_URL  = process.env.SUPABASE_URL || '';
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY || '';
// F-12: nada de salt default fraco. Sem MFA_SALT no servidor, os hashes seriam
// previsíveis (todo mundo conhece a string default). Falha fechado: o handler
// recusa qualquer operação até que a env esteja configurada.
const MFA_SALT = process.env.MFA_SALT || '';

const CODE_TTL_MS = 5 * 60 * 1000;   // validade do código
const RL_WINDOW_MS = 60 * 1000;      // F-12: 1 código por minuto, por dev_id

function hashCode(code) {
  return crypto.createHash('sha256').update(MFA_SALT + ':' + code).digest('hex');
}

function randomCode() {
  return String(crypto.randomInt(100000, 999999));
}

async function sb(path, opts) {
  if (!SB_URL || !SB_KEY) {
    const missing = [];
    if (!SB_URL) missing.push('SUPABASE_URL');
    if (!SB_KEY) missing.push('SUPABASE_SERVICE_KEY');
    throw new Error('Supabase não configurado no servidor — variáveis ausentes: ' + missing.join(', '));
  }
  const r = await fetch(`${SB_URL.replace(/\/+$/, '')}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Prefer': 'return=representation',
      ...(opts?.headers || {}),
    },
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`Supabase ${path}: ${r.status} — ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function zapiSend(phone, message) {
  const token = process.env.ZAPI_TOKEN || '';
  const instance = process.env.ZAPI_INSTANCE_ID || '';
  const clientTk = process.env.ZAPI_CLIENT_TOKEN || '';
  if (!token || !instance) throw new Error('Z-API não configurada');
  const url = `https://api.z-api.io/instances/${encodeURIComponent(instance)}/token/${encodeURIComponent(token)}/send-text`;
  const headers = { 'Content-Type': 'application/json' };
  if (clientTk) headers['Client-Token'] = clientTk;
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ phone: String(phone).replace(/\D/g, ''), message }),
  });
  if (!r.ok) throw new Error(`Z-API HTTP ${r.status}`);
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { return res.status(405).json({ error: 'use POST' }); }

  const action = req.query?.action;

  // F-12: sem salt configurado, não operamos (hash seria fraco/previsível).
  if (!MFA_SALT) {
    console.error('[mfa] MFA_SALT ausente — recusando operação.');
    return res.status(500).json({ error: 'MFA indisponível: MFA_SALT não configurado no servidor.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    if (action === 'challenge') {
      const { devId, telefone } = body;
      if (!devId || !telefone) return res.status(400).json({ error: 'devId e telefone obrigatórios' });

      // F-12: rate-limit — no máximo 1 código por minuto por dev_id (evita spam
      // de WhatsApp / brute-force de emissão). Deriva o instante de emissão do
      // expires_at (sempre = emissão + TTL); o upsert preserva created_at antigo,
      // então não dá pra usar created_at aqui.
      const existing = await sb(`mfa_codes?dev_id=eq.${encodeURIComponent(devId)}&select=expires_at`);
      if (existing && existing[0] && existing[0].expires_at) {
        const issuedAt = new Date(existing[0].expires_at).getTime() - CODE_TTL_MS;
        const elapsed = Date.now() - issuedAt;
        if (elapsed >= 0 && elapsed < RL_WINDOW_MS) {
          const retryAfter = Math.ceil((RL_WINDOW_MS - elapsed) / 1000);
          res.setHeader('Retry-After', String(retryAfter));
          return res.status(429).json({ error: `Aguarde ${retryAfter}s para solicitar um novo código.`, retry_after: retryAfter });
        }
      }

      const code = randomCode();
      const hash = hashCode(code);
      const expires = new Date(Date.now() + CODE_TTL_MS).toISOString();
      // Upsert (chave primária = dev_id)
      await sb('mfa_codes', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ dev_id: devId, code_hash: hash, expires_at: expires, attempts: 0 }),
      });
      await zapiSend(telefone, `Seu código de acesso COBRASQ: ${code}\nVálido por 5 minutos. Não compartilhe.`);
      return res.status(200).json({ ok: true, expires_at: expires });
    }

    if (action === 'verify') {
      const { devId, code } = body;
      if (!devId || !code) return res.status(400).json({ error: 'devId e code obrigatórios' });
      const rows = await sb(`mfa_codes?dev_id=eq.${encodeURIComponent(devId)}`);
      if (!rows || rows.length === 0) {
        return res.status(400).json({ error: 'Código expirado ou inexistente. Solicite um novo.' });
      }
      const row = rows[0];
      if (new Date(row.expires_at).getTime() < Date.now()) {
        await sb(`mfa_codes?dev_id=eq.${encodeURIComponent(devId)}`, { method: 'DELETE' });
        return res.status(400).json({ error: 'Código expirado. Solicite um novo.' });
      }
      if ((row.attempts || 0) >= 5) {
        await sb(`mfa_codes?dev_id=eq.${encodeURIComponent(devId)}`, { method: 'DELETE' });
        return res.status(429).json({ error: 'Muitas tentativas. Solicite um novo código.' });
      }
      // Comparação em tempo constante (evita timing attack na verificação do hash).
      const _h = Buffer.from(hashCode(String(code)));
      const _stored = Buffer.from(String(row.code_hash || ''));
      const ok = _h.length === _stored.length && _h.length > 0 && crypto.timingSafeEqual(_h, _stored);
      if (!ok) {
        await sb(`mfa_codes?dev_id=eq.${encodeURIComponent(devId)}`, {
          method: 'PATCH', body: JSON.stringify({ attempts: (row.attempts || 0) + 1 }),
        });
        return res.status(400).json({ error: 'Código incorreto.' });
      }
      // Sucesso — consome
      await sb(`mfa_codes?dev_id=eq.${encodeURIComponent(devId)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'action deve ser challenge ou verify' });
  } catch (err) {
    console.error('[mfa]', err);
    return res.status(500).json({ error: err.message });
  }
};
