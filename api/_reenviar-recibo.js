// api/_reenviar-recibo.js — Reenvia manualmente o recibo (PDF + texto) de um
// lançamento já pago, pro telefone ATUAL do devedor. Existe porque o envio
// automático (api/_processar-recebimento.js) falha silenciosamente quando o
// telefone salvo em devedores.telefone está mal formatado (achado 2026-08-07,
// caso Débora Aparecida Simioni: zero de discagem sobrando na frente do DDI —
// corrigido em lote no cadastro, mas o recibo daquele pagamento específico
// nunca saiu e precisa ser reenviado manualmente depois da correção).
//
// Gated ao proprietário (mesmo padrão de api/_boletos-para-lancamentos.js).
// Despachado por api/automacao.js (?action=reenviar-recibo).

const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');
const { asaasReq } = require('./_asaas.js');
const { zapiSendText, zapiSendDocumentPdf, normalizarTelefone } = require('./_zapi.js');
const { gerarReciboPdfBase64, formaPagamento } = require('./_recibo.js');

function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'tudo bem'; }

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireUser(req, res);
  if (!user) return;

  let papel = null;
  try {
    const rows = await sbFetch(`app_users?id=eq.${encodeURIComponent(user.id)}&select=papel`);
    papel = Array.isArray(rows) && rows[0] ? rows[0].papel : null;
  } catch (_e) {
    return res.status(500).json({ error: 'Não foi possível verificar permissão.' });
  }
  if (papel !== 'proprietario') {
    return res.status(403).json({ error: 'Apenas o proprietário pode reenviar recibo.' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const lancamentoId = body.lancamento_id;
  if (!lancamentoId) return res.status(400).json({ error: 'lancamento_id ausente' });

  try {
    const lancs = await sbFetch(`fin_lancamento?id=eq.${encodeURIComponent(lancamentoId)}&select=*&limit=1`);
    const lanc = lancs && lancs[0];
    if (!lanc) return res.status(404).json({ error: 'lançamento não encontrado' });
    if (lanc.status !== 1) return res.status(400).json({ error: 'lançamento não está pago' });

    // Devedor: cobranca_id (link oficial) ou, se ausente, via fin_operacao que aponta
    // pra este lançamento (lançamentos mais antigos, antes de existir cobranca_id).
    let devedorId = lanc.cobranca_id || null;
    let asaasPaymentId = lanc.raw_payload && lanc.raw_payload.asaas_payment_id;
    if (!devedorId || !asaasPaymentId) {
      const ops = await sbFetch(`fin_operacao?lancamento_receita_id=eq.${encodeURIComponent(lancamentoId)}&select=devedor_id,asaas_payment_id&limit=1`).catch(() => []);
      const op = ops && ops[0];
      if (op) { devedorId = devedorId || op.devedor_id; asaasPaymentId = asaasPaymentId || op.asaas_payment_id; }
    }
    if (!devedorId) return res.status(400).json({ error: 'lançamento sem devedor vinculado — não há telefone pra mandar' });

    const devs = await sbFetch(`devedores?id=eq.${encodeURIComponent(devedorId)}&select=id,nome,telefone,asaas_customer_id&limit=1`);
    const dev = devs && devs[0];
    if (!dev) return res.status(404).json({ error: 'devedor não encontrado' });
    // Mesmo fallback do envio automático: `devedores.telefone` vazio não significa
    // que não há telefone — a fila da Bia costuma ter o número certo (8 devedores
    // nessa situação em 27/08/2026). Sem isto, o reenvio manual — que existe
    // justamente para salvar o recibo que não saiu — também desiste.
    let tel = normalizarTelefone(dev.telefone || '');
    let telOrigem = tel ? 'devedores' : '';
    if (!tel) {
      const pid = asaasPaymentId || lanc.asaas_payment_id || '';
      const filtros = [];
      if (pid) filtros.push(`asaas_payment_id=eq.${encodeURIComponent(pid)}`);
      if (dev.asaas_customer_id) filtros.push(`asaas_customer_id=eq.${encodeURIComponent(dev.asaas_customer_id)}`);
      for (const f of filtros) {
        const bia = await sbFetch(`bia_cobranca?${f}&select=telefone&limit=1`).catch(() => []);
        const t = normalizarTelefone((bia && bia[0] && bia[0].telefone) || '');
        if (t) { tel = t; telOrigem = 'bia_cobranca'; break; }
      }
    }
    if (!tel) return res.status(400).json({ error: 'devedor sem telefone — nem no cadastro, nem na fila da Bia' });

    let billingType = null;
    if (asaasPaymentId) {
      try { const p = await asaasReq('GET', `/payments/${encodeURIComponent(asaasPaymentId)}`); billingType = p.billingType; } catch (_e) { /* segue sem forma de pagamento */ }
    }

    const valorNum = Math.abs(Number(lanc.valor_pago ?? lanc.valor) || 0);
    const dadosRec = {
      nome: dev.nome || 'Cliente',
      valorNum,
      valorFmt: valorNum.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      dataISO: lanc.data_pagamento || lanc.data_competencia,
      forma: formaPagamento(billingType),
      num: 'Nº ' + String(asaasPaymentId || lanc.id).slice(-6).toUpperCase(),
    };

    let b64 = '';
    try { b64 = await gerarReciboPdfBase64(dadosRec); } catch (e) { console.warn('[reenviar-recibo] gerar PDF:', e.message); }

    let pdfEnviado = false;
    if (b64) { try { pdfEnviado = await zapiSendDocumentPdf(tel, b64, 'Recibo COBRASQ.pdf'); } catch (_e) { pdfEnviado = false; } }

    const meioTxt = { PIX: 'do Pix', BOLETO: 'do boleto', CREDIT_CARD: 'do cartão', DEBIT_CARD: 'do cartão' }[String(billingType || '').toUpperCase()] || 'do pagamento';
    const linhaAnexo = pdfEnviado ? 'Em anexo, seu recibo de pagamento.' : '';
    const msg = `*Financeiro COBRASQ*\n${firstName(dev.nome)}, segue o comprovante ${meioTxt} no valor de R$ ${dadosRec.valorFmt}. ✅${linhaAnexo ? '\n\n' + linhaAnexo : ''}\n_Agradecemos!_`;

    let zap = null;
    try { zap = await zapiSendText(tel, msg); } catch (e) { zap = { error: e.message }; }

    return res.status(200).json({
      ok: true,
      lancamento_id: lancamentoId,
      devedor: dev.nome,
      telefone_usado: tel,
      telefone_origem: telOrigem,
      pdf_enviado: pdfEnviado,
      texto_enviado: !!(zap && zap.messageId),
      erro_texto: zap && zap.error,
    });
  } catch (e) {
    console.error('[reenviar-recibo]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
