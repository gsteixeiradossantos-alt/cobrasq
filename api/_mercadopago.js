// api/_mercadopago.js — Gera um LINK DE PAGAMENTO REAL de CARTÃO via Mercado Pago
// (Checkout Pro / preferências). Chamado pela aba "Negociar" quando o card
// "Cartão (Mercado Pago)" está habilitado (crm_mp_config.ativo) — cria uma
// preferência com o VALOR NEGOCIADO e devolve o init_point (link) que o front
// manda ao devedor por WhatsApp. Se a env não estiver configurada, responde
// ok:false e o front cai no FALLBACK proposta-texto.
//
// Roteado por api/automacao.js como ação 'mercadopago' (não é função Vercel de
// topo — o "_" prefixado não conta no limite de 12 do plano Hobby).
//
// SEGREDO: o access token vive SÓ no servidor (process.env.MERCADOPAGO_ACCESS_TOKEN).
// Nunca é retornado ao front.
//
// Para ativar: no painel do Mercado Pago → Seus negócios/aplicações → Credenciais
// de produção → "Access Token" (começa com APP_USR-...). Coloque em
// MERCADOPAGO_ACCESS_TOKEN no Vercel (env var, escopo Production). PORTAL_URL é
// opcional (usado nas back_urls de retorno após o pagamento).

const { requireUser, applyCors } = require('./_auth.js');

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // Só usuário logado (staff) gera link — não expõe o endpoint a anônimos.
  const user = await requireUser(req, res);
  if (!user) return; // requireUser já respondeu 401/5xx

  const token = process.env.MERCADOPAGO_ACCESS_TOKEN || '';
  if (!token) {
    // Front cai no fallback texto. NÃO devolvemos o token (nem existe).
    return res.status(200).json({ ok: false, error: 'MERCADOPAGO_ACCESS_TOKEN não configurado' });
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});

  // GUARDRAIL: o valor vem do front (valor negociado). Não inventamos valor —
  // apenas validamos que é número > 0.
  const valor = round2(body.valor);
  if (!(valor > 0)) {
    return res.status(400).json({ ok: false, error: 'valor inválido (precisa ser número > 0)' });
  }

  const titulo = String(body.titulo || body.descricao || 'Acordo COBRASQ').slice(0, 250);
  const externalRef = [body.devedor_id, body.acordo_id].filter(Boolean).join(':') || undefined;
  const portal = String(process.env.PORTAL_URL || '').trim();

  const pref = {
    items: [{
      title: titulo,
      quantity: 1,
      currency_id: 'BRL',
      unit_price: valor,
    }],
    // Mantém cartão habilitado; limita o parcelamento a 12x.
    payment_methods: {
      installments: 12,
    },
  };
  if (externalRef) pref.external_reference = externalRef;
  if (portal) {
    pref.back_urls = { success: portal, pending: portal, failure: portal };
  }

  try {
    const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(pref),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status !== 201) {
      const msg = (data && (data.message || data.error)) || ('Mercado Pago respondeu ' + r.status);
      console.error('[mercadopago] preferência falhou:', r.status, msg);
      return res.status(200).json({ ok: false, error: String(msg) });
    }
    const initPoint = data.init_point || data.sandbox_init_point || '';
    if (!initPoint) {
      return res.status(200).json({ ok: false, error: 'Mercado Pago não retornou init_point' });
    }
    return res.status(200).json({ ok: true, init_point: initPoint, id: data.id || null });
  } catch (e) {
    console.error('[mercadopago]', e && e.message);
    return res.status(200).json({ ok: false, error: 'Falha ao chamar Mercado Pago: ' + (e && e.message ? e.message : 'erro') });
  }
};
