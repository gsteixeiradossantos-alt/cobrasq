// api/emitir-acordo.js — Emite o parcelamento no Asaas para um acordo ASSINADO e
// manda o boleto/PIX ao devedor por WhatsApp. (PR2 do roadmap de automação.)
//
// Chamado por:
//   - zapsign-webhook (Supabase edge) ao assinar — server-to-server, header
//     x-emit-secret == EMIT_ACORDO_SECRET. Gated por AUTO_EMIT_ACORDO=on para não
//     duplicar com o fluxo n8n legado enquanto ele não é desligado.
//   - app (botão manual no Faturamento) — usuário Supabase logado; sempre emite.
//
// Idempotência: pula se o acordo já tem cobranca_id OU metadata.boletos_emitidos.
// externalReference do pagamento = acordo.id (a baixa por parcela e a "operação
// única" recebimento↔repasse são fechadas na PR3, que consome o asaas-webhook).

const crypto = require('crypto');
const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');
const { asaasReq, ensureAsaasCustomer } = require('./_asaas.js');
const { zapiSendText } = require('./_zapi.js');

function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function addDaysISO(d) { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); }
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'tudo bem'; }
function fmtR(v) { return 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtDateBR(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || ''); }

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth: server-to-server (segredo) OU usuário logado (chamada manual).
  const secret = process.env.EMIT_ACORDO_SECRET || '';
  const viaSecret = timingSafeEq(req.headers['x-emit-secret'] || '', secret);
  let manual = false;
  if (!viaSecret) {
    const user = await requireUser(req, res);
    if (!user) return; // requireUser já respondeu 401/5xx
    manual = true;
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const acordoId = body.acordo_id || req.query.acordo_id;
  if (!acordoId) return res.status(400).json({ error: 'acordo_id ausente' });

  try {
    const acs = await sbFetch(`acordos?id=eq.${encodeURIComponent(acordoId)}&select=*&limit=1`);
    const acordo = acs[0];
    if (!acordo) return res.status(404).json({ error: 'acordo não encontrado' });

    const meta = acordo.metadata || {};
    if (acordo.cobranca_id || meta.boletos_emitidos) {
      return res.status(200).json({ ok: true, skipped: 'já emitido', acordo_id: acordoId });
    }
    // Trava anti-duplicação com o n8n: automático só emite com AUTO_EMIT_ACORDO=on.
    if (!manual && String(process.env.AUTO_EMIT_ACORDO || '').toLowerCase() !== 'on') {
      return res.status(200).json({ ok: true, skipped: 'auto-emit desligado (AUTO_EMIT_ACORDO≠on)', acordo_id: acordoId });
    }

    const devs = await sbFetch(`devedores?id=eq.${acordo.devedor_id}&select=id,nome,doc,email,telefone,asaas_customer_id&limit=1`);
    const dev = devs[0];
    if (!dev) return res.status(404).json({ error: 'devedor não encontrado' });

    const { customerId, created } = await ensureAsaasCustomer(dev);
    if (customerId && customerId !== dev.asaas_customer_id) {
      await sbFetch(`devedores?id=eq.${dev.id}`, { method: 'PATCH', body: JSON.stringify({ asaas_customer_id: customerId }) }).catch(() => {});
    }

    // Monta o parcelamento a partir dos termos do acordo.
    const parcelas = Array.isArray(acordo.parcelas) ? acordo.parcelas : [];
    const nParc = acordo.num_parcelas || parcelas.length || 1;
    const total = Number(acordo.valor_total) || parcelas.reduce((s, p) => s + (Number(p.valor) || 0), 0);
    if (!(total > 0)) return res.status(400).json({ error: 'acordo sem valor_total' });
    const firstDue = acordo.data_primeiro_venc || (parcelas[0] && (parcelas[0].venc || parcelas[0].vencimento)) || addDaysISO(3);

    const charge = await asaasReq('POST', '/payments', {
      customer: customerId,
      billingType: 'BOLETO',
      installmentCount: nParc,
      totalValue: round2(total),
      dueDate: firstDue,
      description: `Acordo ${dev.nome} — ${nParc}x`,
      externalReference: acordo.id,
      fine: { value: 2 },
      interest: { value: 1 },
    });
    // charge = pagamento da 1ª parcela; charge.installment = id da série.
    const invoiceUrl = charge.invoiceUrl || charge.bankSlipUrl || '';

    const newMeta = {
      ...meta,
      boletos_emitidos: true,
      emitido_em: new Date().toISOString(),
      emitido_via: manual ? 'manual' : 'auto',
      asaas_installment_id: charge.installment || null,
      asaas_first_payment_id: charge.id || null,
      asaas_invoice_url: invoiceUrl,
      asaas_customer_id: customerId,
    };
    await sbFetch(`acordos?id=eq.${acordo.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'ativo', metadata: newMeta }) });

    // WhatsApp com o link do boleto/PIX (best-effort, não derruba a emissão).
    let zap = null;
    const tel = String(dev.telefone || '').replace(/\D/g, '');
    if (tel && invoiceUrl) {
      const msg = `Olá, ${firstName(dev.nome)}! Seu acordo foi confirmado. ✅\n\n` +
        `Parcelamento: ${nParc}x — total ${fmtR(total)}.\n` +
        `1º vencimento: ${fmtDateBR(firstDue)}.\n\n` +
        `Acesse seu boleto/PIX aqui:\n${invoiceUrl}\n\n` +
        `Qualquer dúvida, é só responder esta mensagem. — Cobrasq`;
      try { zap = await zapiSendText(tel, msg); } catch (e) { zap = { error: e.message }; }
    }

    await sbFetch('devedor_eventos', {
      method: 'POST',
      body: JSON.stringify({
        devedor_id: dev.id,
        tipo: 'asaas_boletos_emitidos',
        payload: {
          acordo_id: acordo.id,
          installment: charge.installment || null,
          parcelas: nParc,
          total,
          invoice_url: invoiceUrl,
          whatsapp: zap && zap.messageId ? 'enviado' : 'falha/sem-tel',
          via: manual ? 'manual' : 'auto',
        },
        autor_nome: manual ? 'Faturamento (manual)' : 'ZapSign (auto)',
      }),
    }).catch(() => {});

    return res.status(200).json({
      ok: true,
      acordo_id: acordo.id,
      installment: charge.installment || null,
      parcelas: nParc,
      total,
      invoice_url: invoiceUrl,
      whatsapp: !!(zap && zap.messageId),
      customer_criado: created,
    });
  } catch (e) {
    console.error('[emitir-acordo]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
