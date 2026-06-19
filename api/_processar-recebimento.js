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
      const devs = await sbFetch(`devedores?id=eq.${acordo.devedor_id}&select=id,nome,telefone,cliente_id&limit=1`).catch(() => []);
      devedor = devs[0] || null;
    }
    // Fallback: casa o devedor pelo customer Asaas se não veio pelo acordo.
    if (!devedor && payment.customer) {
      const devs = await sbFetch(`devedores?asaas_customer_id=eq.${encodeURIComponent(payment.customer)}&select=id,nome,telefone,cliente_id&limit=1`).catch(() => []);
      devedor = devs[0] || null;
    }
    if (devedor && devedor.cliente_id) {
      const cls = await sbFetch(`clientes?id=eq.${devedor.cliente_id}&select=id,nome&limit=1`).catch(() => []);
      credor = cls[0] || null;
    }
    // FASE C2 (tempo-2): valor original vem de `cobrancas` (fonte única; invariante
    // cobranca.id == devedor.id), não mais de devedores.valor_orig (coluna depreciada).
    let cobValorOrig = null;
    if (devedor) {
      const cobs = await sbFetch(`cobrancas?id=eq.${devedor.id}&select=valor_orig&limit=1`).catch(() => []);
      cobValorOrig = cobs[0] ? cobs[0].valor_orig : null;
    }

    // Split capital/honorário.
    const valorRecebido = round2(payment.value);
    const acordoTotal = Number(acordo && acordo.valor_total) || 0;
    const capitalBase = Number((acordo && acordo.metadata && acordo.metadata.capital_credor)) ||
                        Number(cobValorOrig) || 0;
    // P1 (auditoria 2026-06): só rateia quando há base segura (acordo.valor_total > 0).
    // Sem acordo vinculado, o código antigo forçava capitalRatio=0 → 100% honorário e
    // NUNCA repassava capital ao credor, silenciosamente. Agora, na falta de base,
    // marca a operação para REVISÃO MANUAL em vez de classificar errado.
    const podeRatear = acordoTotal > 0;
    const capitalRatio = podeRatear ? Math.min(capitalBase / acordoTotal, 1) : null;
    const valorCapital = podeRatear ? round2(valorRecebido * capitalRatio) : 0;
    const valorHonorario = podeRatear ? round2(valorRecebido - valorCapital) : 0;
    const repasseStatus = !podeRatear ? 'revisar' : (valorCapital > 0 ? 'pendente' : 'nao_aplica');

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
      repasse_status: repasseStatus,
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

    // Ponte fin_lancamento: registra a RECEITA do recebimento (já paga) e a DESPESA
    // de repasse (nasce ATIVA/pendente porque o recebimento confirmou; vira "pago"
    // quando o PIX de repasse efetiva — /api/repassar e /api/repasse-concluido).
    // Convenção de sinal do app: despesa com valor negativo. conta_id/contato_id ficam
    // nulos (o módulo fin_* veio do Controlle; vínculo fino é passo futuro).
    if (operacao && operacao.id) {
      try {
        const credorNome = (credor && credor.nome) || '';
        const devNome = (devedor && devedor.nome) || 'devedor';
        const parcTxt = row.parcela && row.total_parcelas ? ` ${row.parcela}/${row.total_parcelas}` : '';
        const rec = await sbFetch('fin_lancamento', { method: 'POST', body: JSON.stringify({
          descricao: `Recebimento — ${devNome}${parcTxt}`,
          valor: valorRecebido, valor_pago: valorRecebido,
          tipo_movimento: 1, status: 1,
          data_competencia: row.recebido_em, data_pagamento: row.recebido_em,
          numero_parcela: row.parcela, total_parcelas: row.total_parcelas,
        }) }).catch(() => null);
        const lancReceitaId = (rec && rec[0] && rec[0].id) || null;
        let lancDespesaId = null;
        if (valorCapital > 0) {
          const desp = await sbFetch('fin_lancamento', { method: 'POST', body: JSON.stringify({
            descricao: `Repasse ao credor — ${credorNome || '—'}${parcTxt}`,
            valor: -valorCapital,
            tipo_movimento: 0, status: 0,
            data_competencia: row.recebido_em, data_vencimento: row.recebido_em,
            numero_parcela: row.parcela, total_parcelas: row.total_parcelas,
          }) }).catch(() => null);
          lancDespesaId = (desp && desp[0] && desp[0].id) || null;
        }
        if (lancReceitaId || lancDespesaId) {
          await sbFetch(`fin_operacao?id=eq.${operacao.id}`, { method: 'PATCH', body: JSON.stringify({ lancamento_receita_id: lancReceitaId, lancamento_despesa_id: lancDespesaId }) }).catch(() => {});
          operacao.lancamento_despesa_id = lancDespesaId;
        }
      } catch (e) { console.warn('[processar-recebimento] ponte fin_lancamento:', e.message); }
    }

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
