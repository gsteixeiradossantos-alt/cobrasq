// api/processar-recebimento.js — Processa um recebimento confirmado do Asaas como
// "operação única" (PR3): cria a fin_operacao da parcela paga (recebimento + split
// capital/honorário + estado de repasse), e manda o recibo ao devedor (R4).
//
// Chamado server-to-server pelo asaas-webhook (header x-emit-secret ==
// EMIT_ACORDO_SECRET). Idempotente por asaas_payment_id (fin_operacao.asaas_payment_id
// é UNIQUE). O repasse PIX em si é semiautomático e fica na PR4 (a operação nasce com
// repasse_status='pendente' quando há capital a repassar).
//
// Split (regra confirmada): credor recebe o CAPITAL (principal); excedente = honorário,
// diluído proporcionalmente por parcela. Base de capital = acordo.metadata.capital_credor
// senão devedor.valor_orig.

const crypto = require('crypto');
const { sbFetch } = require('./_sb.js');
const { asaasReq } = require('./_asaas.js');
const { zapiSendText } = require('./_zapi.js');

function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
function fmtR(v) { return 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!timingSafeEq(req.headers['x-emit-secret'] || '', process.env.EMIT_ACORDO_SECRET || '')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  let payment = body.payment || null;
  const paymentId = body.payment_id || (payment && payment.id);
  if (!paymentId) return res.status(400).json({ error: 'payment_id/payment ausente' });

  try {
    // Idempotência: já processamos este pagamento?
    const existing = await sbFetch(`fin_operacao?asaas_payment_id=eq.${encodeURIComponent(paymentId)}&select=id&limit=1`);
    if (existing[0]) return res.status(200).json({ ok: true, duplicate: true, operacao_id: existing[0].id });

    // Garante o payload do pagamento (busca no Asaas se só veio o id).
    if (!payment) payment = await asaasReq('GET', `/payments/${encodeURIComponent(paymentId)}`);

    const acordoId = payment.externalReference || '';
    let acordo = null, devedor = null, credor = null;
    if (acordoId) {
      const acs = await sbFetch(`acordos?id=eq.${encodeURIComponent(acordoId)}&select=*&limit=1`).catch(() => []);
      acordo = acs[0] || null;
    }
    if (acordo) {
      const devs = await sbFetch(`devedores?id=eq.${acordo.devedor_id}&select=id,nome,telefone,valor_orig,cliente_id&limit=1`).catch(() => []);
      devedor = devs[0] || null;
    }
    // Fallback: casa o devedor pelo customer Asaas se não veio pelo acordo.
    if (!devedor && payment.customer) {
      const devs = await sbFetch(`devedores?asaas_customer_id=eq.${encodeURIComponent(payment.customer)}&select=id,nome,telefone,valor_orig,cliente_id&limit=1`).catch(() => []);
      devedor = devs[0] || null;
    }
    if (devedor && devedor.cliente_id) {
      const cls = await sbFetch(`clientes?id=eq.${devedor.cliente_id}&select=id,nome&limit=1`).catch(() => []);
      credor = cls[0] || null;
    }

    // Split capital/honorário.
    const valorRecebido = round2(payment.value);
    const acordoTotal = Number(acordo && acordo.valor_total) || 0;
    const capitalBase = Number((acordo && acordo.metadata && acordo.metadata.capital_credor)) ||
                        Number(devedor && devedor.valor_orig) || 0;
    const capitalRatio = acordoTotal > 0 ? Math.min(capitalBase / acordoTotal, 1) : 0;
    const valorCapital = round2(valorRecebido * capitalRatio);
    const valorHonorario = round2(valorRecebido - valorCapital);

    const row = {
      acordo_id: acordo ? acordo.id : null,
      devedor_id: devedor ? devedor.id : null,
      credor_id: credor ? credor.id : null,
      asaas_payment_id: paymentId,
      asaas_installment_id: payment.installment || (acordo && acordo.metadata && acordo.metadata.asaas_installment_id) || null,
      parcela: payment.installmentNumber || null,
      total_parcelas: (acordo && acordo.num_parcelas) || null,
      valor_recebido: valorRecebido,
      valor_capital: valorCapital,
      valor_honorario: valorHonorario,
      recebido_em: payment.paymentDate || payment.clientPaymentDate || new Date().toISOString().slice(0, 10),
      recebimento_status: 'recebido',
      repasse_status: valorCapital > 0 ? 'pendente' : 'nao_aplica',
      nf_status: 'pendente',
      metadata: {
        capital_base: capitalBase,
        capital_ratio: capitalRatio,
        billing_type: payment.billingType || null,
        net_value: payment.netValue ?? null,
        credor_nome: credor ? credor.nome : null,
      },
    };
    const inserted = await sbFetch('fin_operacao', { method: 'POST', body: JSON.stringify(row) });
    const operacao = Array.isArray(inserted) ? inserted[0] : inserted;

    // PR5: emissão automática da NFS-e (gated por AUTO_EMIT_NF=on). Best-effort —
    // depende de configuração fiscal municipal na conta Asaas. O disparo manual fica
    // sempre disponível em /api/emitir-nf.
    let nf = null;
    if (operacao && operacao.id && String(process.env.AUTO_EMIT_NF || '').toLowerCase() === 'on') {
      try {
        const base = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
        if (base) {
          const r = await fetch(base + '/api/emitir-nf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-emit-secret': process.env.EMIT_ACORDO_SECRET || '' },
            body: JSON.stringify({ operacao_id: operacao.id }),
          });
          nf = await r.json().catch(() => ({ status: r.status }));
        }
      } catch (e) { nf = { error: e.message }; }
    }

    // Recibo automático ao devedor (R4) — best-effort.
    let zap = null;
    const tel = String((devedor && devedor.telefone) || '').replace(/\D/g, '');
    if (tel) {
      const parc = row.parcela && row.total_parcelas ? ` (parcela ${row.parcela}/${row.total_parcelas})` : '';
      const ola = firstName(devedor && devedor.nome);
      const msg = `${ola ? 'Olá, ' + ola + '! ' : ''}Recebemos seu pagamento${parc} no valor de ${fmtR(valorRecebido)}. ✅\n\n` +
        `Obrigado! Seu recibo está registrado. — Cobrasq`;
      try { zap = await zapiSendText(tel, msg); } catch (e) { zap = { error: e.message }; }
    }

    return res.status(200).json({
      ok: true,
      operacao_id: operacao && operacao.id,
      valor_recebido: valorRecebido,
      valor_capital: valorCapital,
      valor_honorario: valorHonorario,
      repasse_status: row.repasse_status,
      recibo_enviado: !!(zap && zap.messageId),
      nf,
    });
  } catch (e) {
    console.error('[processar-recebimento]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
