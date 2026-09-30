// api/_tarifas-asaas.js — Lança no financeiro (fin_lancamento, conta Asaas) as tarifas
// que o Asaas desconta do saldo, sem duplicar.
//
// Até 30/09/2026 nenhum código criava essas linhas: as "Tarifa Asaas (Pix|boleto|
// mensageria|Pix enviado)" eram digitadas à mão na conciliação, e cada uma esquecida
// deixava o saldo do painel acima do saldo real (conciliação de 30/09: 3 tarifas
// faltando, 2 duplicadas, 1 com a data do pagamento em vez da do crédito).
//
// Duas entradas:
//   1. garantirTarifaDoPagamento — chamada pelo processar-recebimento (webhook) logo
//      depois de criar a fin_operacao. Tarifa = value − netValue do pagamento.
//   2. sincronizarTarifasAsaas — chamada pelo cron diário (cron-regua) e pela ação
//      ?action=tarifas-asaas. Lê /v3/financialTransactions, a ÚNICA fonte das tarifas
//      de Pix enviado (TRANSFER_FEE) e de mensageria (PAYMENT_MESSAGING_NOTIFICATION_FEE)
//      — não há webhook delas, e GET /transfers/{id} responde 403 com a nossa chave.
//      Também cobre a PAYMENT_FEE de pagamento cujo webhook falhou.
//
// Regras conferidas contra a API em 30/09/2026 (102 recebimentos de ago–set):
//   • value − netValue == tarifa do extrato em 102/102;
//   • a tarifa cai no dia do CRÉDITO (creditDate), não no do pagamento: boleto pago
//     25/08 (Bruna) teve crédito e tarifa em 26/08.
//
// Idempotência: marcador `[asaas_tarifa:<paymentId>]` (tarifa de recebimento) ou
// `[asaas_ft:<id da transação>]` (Pix enviado, mensageria) em observacoes. O webhook e
// o cron usam a MESMA chave para a tarifa de recebimento — quem chegar primeiro lança,
// o outro vê o marcador e pula. Sem migração: fin_lancamento.asaas_payment_id tem
// índice único e já é do lançamento da receita.
//
// Corte: só lança tarifa com data >= TARIFA_AUTO_DESDE. Tudo antes disso foi lançado
// à mão (sem marcador) e seria duplicado.

const { sbFetch } = require('./_sb.js');
const { asaasReq } = require('./_asaas.js');
const { hojeBR, addDiasBR } = require('./_data.js');

const CONTA_ASAAS = 13;
const CATEGORIA_TARIFA = 8946;  // "Tarifas bancárias" — a das tarifas lançadas à mão
const TARIFA_AUTO_DESDE = '2026-10-01';

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Rótulo do tipo, no formato das linhas que já existem.
function rotuloBilling(billingType) {
  const t = String(billingType || '').toUpperCase();
  if (t === 'PIX') return 'Pix';
  if (t === 'BOLETO') return 'boleto';
  if (t === 'CREDIT_CARD') return 'cartão';
  if (t === 'DEBIT_CARD') return 'cartão de débito';
  return t ? t.toLowerCase() : 'recebimento';
}

function marcadorPagamento(paymentId) { return `[asaas_tarifa:${paymentId}]`; }
function marcadorTransacao(ftId) { return `[asaas_ft:${ftId}]`; }

function descricaoTarifa(rotulo, nome) {
  const n = String(nome || '').trim();
  return `Tarifa Asaas (${rotulo})${n ? ' — ' + n : ''}`;
}

// Tarifa de um pagamento recebido. null se não há tarifa (netValue ausente ou igual).
function tarifaDoPagamento(payment) {
  if (!payment) return null;
  if (payment.value == null || payment.netValue == null) return null;
  const valor = round2(Number(payment.value) - Number(payment.netValue));
  if (!(valor > 0)) return null;
  const data = String(payment.creditDate || payment.estimatedCreditDate || payment.paymentDate ||
                      payment.clientPaymentDate || '').slice(0, 10) || null;
  if (!data) return null;
  return { valor, data, rotulo: rotuloBilling(payment.billingType) };
}

// Nome do pagador no fim da descrição do extrato: "Taxa do Pix - fatura nr. 814327091
// Ivone Klinzer" → "Ivone Klinzer". O Asaas tira o acento; é só o fallback.
function nomeDaDescricaoFatura(desc) {
  const m = String(desc || '').match(/fatura nr\.?\s*\d+\s+(.+)$/i);
  return m ? m[1].trim() : '';
}
// "Transação via Pix com chave para LOIS MOCELIN" → "LOIS MOCELIN".
function nomeDoFavorecido(desc) {
  const m = String(desc || '').match(/\bpara\s+(.+)$/i);
  return m ? m[1].trim() : '';
}
function rotuloDaDescricaoFee(desc) {
  const d = String(desc || '').toLowerCase();
  if (d.includes('pix')) return 'Pix';
  if (d.includes('boleto')) return 'boleto';
  if (d.includes('cart')) return 'cartão';
  return 'recebimento';
}

// Transforma a lista de /financialTransactions nas tarifas a garantir. Puro (testável).
function planejarTarifas(transacoes, desde) {
  const lista = Array.isArray(transacoes) ? transacoes : [];
  const corte = desde || TARIFA_AUTO_DESDE;
  const favorecidoPorTransfer = {};
  for (const t of lista) {
    if (t && t.type === 'TRANSFER' && t.transferId) favorecidoPorTransfer[t.transferId] = nomeDoFavorecido(t.description);
  }
  const out = [];
  for (const t of lista) {
    if (!t || !t.id) continue;
    const data = String(t.date || '').slice(0, 10);
    if (!data || data < corte) continue;
    const valor = round2(-Number(t.value));
    if (!(valor > 0)) continue;
    if (t.type === 'PAYMENT_FEE' && t.paymentId) {
      out.push({ chave: marcadorPagamento(t.paymentId), paymentId: t.paymentId, valor, data,
        rotulo: rotuloDaDescricaoFee(t.description), nome: nomeDaDescricaoFatura(t.description), ftId: t.id });
    } else if (t.type === 'PAYMENT_MESSAGING_NOTIFICATION_FEE') {
      out.push({ chave: marcadorTransacao(t.id), paymentId: t.paymentId || null, valor, data,
        rotulo: 'mensageria', nome: nomeDaDescricaoFatura(t.description), ftId: t.id });
    } else if (t.type === 'TRANSFER_FEE') {
      out.push({ chave: marcadorTransacao(t.id), paymentId: null, valor, data,
        rotulo: 'Pix enviado', nome: (t.transferId && favorecidoPorTransfer[t.transferId]) || '', ftId: t.id,
        transferId: t.transferId || null });
    }
  }
  return out;
}

async function _jaLancada(chave) {
  const rows = await sbFetch(
    `fin_lancamento?conta_id=eq.${CONTA_ASAAS}&observacoes=like.${encodeURIComponent('*' + chave + '*')}&select=id&limit=1`
  );
  return (rows && rows[0]) ? rows[0].id : null;
}

// Conflito no índice fin_lancamento_tarifa_asaas_uidx: o outro caminho (webhook ou
// cron) gravou a mesma tarifa entre a conferência e o insert.
function _ehDuplicada(e) { return /: 409 —|23505/.test(String(e && e.message)); }

// Grava uma tarifa. Não confere o marcador — quem chama confere. Devolve o id, ou
// null se o banco recusou por já existir (índice único).
async function _inserirTarifa({ chave, valor, data, rotulo, nome, cobrancaId, obs }) {
  let ins;
  try {
    ins = await sbFetch('fin_lancamento', { method: 'POST', body: JSON.stringify({
      descricao: descricaoTarifa(rotulo, nome),
      valor: -valor, valor_pago: -valor,
      tipo_movimento: 0, status: 1,
      conta_id: CONTA_ASAAS,
      data_competencia: data, data_vencimento: data, data_pagamento: data,
      cobranca_id: cobrancaId || null,
      observacoes: `${chave} ${obs || ''}`.trim(),
    }) });
  } catch (e) {
    if (_ehDuplicada(e)) return null;
    throw e;
  }
  const id = (ins && ins[0] && ins[0].id) || null;
  if (id) {
    try {
      await sbFetch('fin_lancamento_categoria', { method: 'POST', prefer: 'return=minimal',
        body: JSON.stringify({ lancamento_id: id, categoria_id: CATEGORIA_TARIFA, valor }) });
    } catch (e) { console.warn('[tarifas-asaas] categoria:', e.message); }
  }
  return id;
}

// Webhook: garante a tarifa de UM pagamento recebido. Nunca lança exceção — a tarifa
// não pode derrubar o processamento do recebimento.
async function garantirTarifaDoPagamento({ payment, paymentId, devedor, desde }) {
  try {
    const pid = paymentId || (payment && payment.id);
    const t = tarifaDoPagamento(payment);
    if (!pid || !t) return { skip: 'sem_tarifa' };
    if (t.data < (desde || TARIFA_AUTO_DESDE)) return { skip: 'antes_do_corte', data: t.data };
    const chave = marcadorPagamento(pid);
    const ja = await _jaLancada(chave);
    if (ja) return { skip: 'ja_lancada', id: ja };
    let nome = devedor && devedor.nome;
    if (!nome && payment.customer) {
      try { nome = (await asaasReq('GET', `/customers/${encodeURIComponent(payment.customer)}`)).name; } catch { /* sem nome */ }
    }
    const id = await _inserirTarifa({ chave, ...t, nome, cobrancaId: devedor && devedor.id,
      obs: `Tarifa do pagamento ${pid} (valor ${payment.value} − líquido ${payment.netValue}), via webhook.` });
    if (!id) return { skip: 'ja_lancada' };
    return { id, ...t };
  } catch (e) {
    console.warn('[tarifas-asaas] garantirTarifaDoPagamento:', e.message);
    return { error: e.message };
  }
}

async function _listarTransacoes(startDate, finishDate) {
  const out = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const r = await asaasReq('GET', `/financialTransactions?startDate=${startDate}&finishDate=${finishDate}&limit=100&offset=${offset}`);
    out.push(...((r && r.data) || []));
    if (!r || !r.hasMore) break;
  }
  return out;
}

// Dono (cobranca_id) e nome de uma tarifa ligada a pagamento: pelo lançamento da
// receita desse pagamento; senão pelo customer do Asaas.
async function _donoDoPagamento(paymentId) {
  if (!paymentId) return null;
  try {
    const l = await sbFetch(`fin_lancamento?asaas_payment_id=eq.${encodeURIComponent(paymentId)}&select=cobranca_id&limit=1`);
    let devId = l && l[0] && l[0].cobranca_id;
    if (!devId) {
      const p = await asaasReq('GET', `/payments/${encodeURIComponent(paymentId)}`);
      if (p && p.customer) {
        const d = await sbFetch(`devedores?asaas_customer_id=eq.${encodeURIComponent(p.customer)}&select=id,nome&limit=1`);
        if (d && d[0]) return d[0];
      }
      return null;
    }
    const d = await sbFetch(`devedores?id=eq.${devId}&select=id,nome&limit=1`);
    return (d && d[0]) || { id: devId, nome: '' };
  } catch { return null; }
}

// Cron: varre os últimos `dias` do extrato do Asaas e lança o que faltar.
async function sincronizarTarifasAsaas({ dry = false, dias = 10, desde } = {}) {
  const corte = desde || TARIFA_AUTO_DESDE;
  const hoje = hojeBR();
  let inicio = addDiasBR(-Math.max(1, Number(dias) || 10));
  if (inicio < corte) inicio = corte;
  const res = { inicio, fim: hoje, dry, planejadas: 0, lancadas: [], ja_lancadas: 0, erros: [] };
  if (inicio > hoje) return res;
  const plano = planejarTarifas(await _listarTransacoes(inicio, hoje), corte);
  res.planejadas = plano.length;
  for (const t of plano) {
    try {
      if (await _jaLancada(t.chave)) { res.ja_lancadas++; continue; }
      const dono = await _donoDoPagamento(t.paymentId);
      const nome = (dono && dono.nome) || t.nome;
      if (dry) { res.lancadas.push({ dry: true, descricao: descricaoTarifa(t.rotulo, nome), valor: -t.valor, data: t.data, chave: t.chave }); continue; }
      const id = await _inserirTarifa({ ...t, nome, cobrancaId: dono && dono.id,
        obs: `Extrato Asaas ${t.ftId}${t.transferId ? ' (transferência ' + t.transferId + ')' : ''}, via sincronização diária.` });
      if (!id) { res.ja_lancadas++; continue; }
      res.lancadas.push({ id, descricao: descricaoTarifa(t.rotulo, nome), valor: -t.valor, data: t.data });
    } catch (e) { res.erros.push({ chave: t.chave, error: e.message }); }
  }
  return res;
}

// ?action=tarifas-asaas — disparo manual (mesmo segredo do cron). ?dry=1 só lista.
async function handler(req, res) {
  const crypto = require('crypto');
  const expect = process.env.CRON_SECRET || '';
  if (!expect) return res.status(500).json({ error: 'CRON_SECRET não configurado no servidor.' });
  const auth = req.headers['authorization'] || '';
  const secret = req.headers['x-cron-secret'] || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
  const got = crypto.createHash('sha256').update(String(secret)).digest();
  const exp = crypto.createHash('sha256').update(String(expect)).digest();
  if (!crypto.timingSafeEqual(got, exp)) return res.status(401).json({ error: 'unauthorized' });
  const q = req.query || {};
  try {
    const r = await sincronizarTarifasAsaas({ dry: q.dry === '1' || q.dry === 'true', dias: q.dias });
    return res.status(200).json({ ok: true, ...r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

module.exports = handler;
Object.assign(module.exports, {
  CONTA_ASAAS, CATEGORIA_TARIFA, TARIFA_AUTO_DESDE,
  rotuloBilling, tarifaDoPagamento, planejarTarifas, descricaoTarifa,
  nomeDaDescricaoFatura, nomeDoFavorecido, marcadorPagamento, marcadorTransacao,
  garantirTarifaDoPagamento, sincronizarTarifasAsaas,
});
