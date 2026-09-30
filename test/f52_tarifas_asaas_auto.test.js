/*
 * Teste F-52 — tarifas do Asaas lançadas sozinhas, sem duplicar.
 *
 * Até 30/09/2026 as linhas "Tarifa Asaas (...)" eram digitadas à mão na conciliação;
 * cada uma esquecida deixava o saldo do painel acima do saldo do banco. A conciliação
 * de 30/09 achou 3 faltando, 2 duplicadas e 1 na data do pagamento em vez da do crédito.
 *
 * Confere, sem rede (fetch simulado):
 *   1. tarifa = value − netValue, na data do CRÉDITO (boleto pago 25/08, crédito 26/08);
 *   2. rótulo pelo billingType (PIX → Pix, BOLETO → boleto);
 *   3. webhook reenviado não duplica (marcador em observacoes);
 *   4. o cron usa a MESMA chave da tarifa de recebimento → webhook + cron = 1 linha;
 *   5. Pix enviado e mensageria saem do extrato, com o nome do favorecido/pagador;
 *   6. nada antes do corte (lançado à mão, sem marcador) é relançado.
 *
 * Como rodar:
 *   node test/f52_tarifas_asaas_auto.test.js
 */
'use strict';

const assert = require('assert');

process.env.SUPABASE_URL = 'https://sb.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.ASAAS_API_KEY = 'k';
process.env.ASAAS_ENV = 'production';

// ── banco e Asaas de mentira ─────────────────────────────────────────────────────
const db = { fin_lancamento: [], fin_lancamento_categoria: [] };
let extrato = [];
let nextId = 1000;
function resp(obj, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(obj) };
}
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.host === 'www.asaas.com') {
    if (u.pathname.endsWith('/financialTransactions')) return resp({ data: extrato, hasMore: false });
    if (u.pathname.includes('/customers/')) return resp({ name: 'Cliente Do Asaas' });
    if (u.pathname.includes('/payments/')) return resp({ id: 'x', customer: null });
    return resp({}, 404);
  }
  const tabela = u.pathname.replace('/rest/v1/', '');
  const method = (opts.method || 'GET').toUpperCase();
  if (method === 'POST') {
    const row = { id: nextId++, ...JSON.parse(opts.body) };
    (db[tabela] = db[tabela] || []).push(row);
    return resp([row]);
  }
  // GET: só os filtros usados pelo módulo.
  let rows = (db[tabela] || []).slice();
  for (const [k, v] of u.searchParams) {
    if (['select', 'limit', 'order'].includes(k)) continue;
    if (v.startsWith('eq.')) rows = rows.filter(r => String(r[k]) === v.slice(3));
    else if (v.startsWith('like.')) {
      const alvo = v.slice(5).replace(/^\*|\*$/g, '');
      rows = rows.filter(r => String(r[k] || '').includes(alvo));
    }
  }
  return resp(rows);
};

const T = require('../api/_tarifas-asaas.js');

(async () => {
  // 1 + 2 — regra da tarifa e do rótulo (dados reais de 26/08/2026, nome trocado).
  const boleto = { id: 'pay_bol', value: 400, netValue: 398.01, billingType: 'BOLETO',
    paymentDate: '2026-08-25', creditDate: '2026-08-26', customer: 'cus_1' };
  assert.deepStrictEqual(T.tarifaDoPagamento(boleto), { valor: 1.99, data: '2026-08-26', rotulo: 'boleto' });
  assert.strictEqual(T.tarifaDoPagamento({ ...boleto, billingType: 'PIX' }).rotulo, 'Pix');
  assert.strictEqual(T.tarifaDoPagamento({ ...boleto, creditDate: null, estimatedCreditDate: '2026-08-27' }).data, '2026-08-27');
  assert.strictEqual(T.tarifaDoPagamento({ ...boleto, netValue: 400 }), null, 'sem tarifa não lança');
  assert.strictEqual(T.tarifaDoPagamento({ ...boleto, netValue: undefined }), null, 'sem netValue não chuta');
  assert.strictEqual(T.descricaoTarifa('Pix', 'Fulana de Tal'), 'Tarifa Asaas (Pix) — Fulana de Tal');

  // 6 — antes do corte: não lança (as de até 30/09 já foram lançadas à mão).
  const antes = await T.garantirTarifaDoPagamento({ payment: boleto, paymentId: 'pay_bol', devedor: { id: 'd1', nome: 'Fulana' } });
  assert.strictEqual(antes.skip, 'antes_do_corte');
  assert.strictEqual(db.fin_lancamento.length, 0);

  // 3 — webhook depois do corte lança UMA vez, com o formato das linhas manuais.
  const pix = { id: 'pay_pix', value: 506, netValue: 504.01, billingType: 'PIX',
    paymentDate: '2026-10-02', creditDate: '2026-10-02', customer: 'cus_2' };
  const r1 = await T.garantirTarifaDoPagamento({ payment: pix, paymentId: 'pay_pix', devedor: { id: 'dev-1', nome: 'Fulana de Tal' } });
  const r2 = await T.garantirTarifaDoPagamento({ payment: pix, paymentId: 'pay_pix', devedor: { id: 'dev-1', nome: 'Fulana de Tal' } });
  assert.ok(r1.id, 'lançou');
  assert.strictEqual(r2.skip, 'ja_lancada', 'reenvio do webhook não duplica');
  assert.strictEqual(db.fin_lancamento.length, 1);
  const l = db.fin_lancamento[0];
  assert.strictEqual(l.descricao, 'Tarifa Asaas (Pix) — Fulana de Tal');
  assert.strictEqual(l.valor, -1.99);
  assert.strictEqual(l.valor_pago, -1.99);
  assert.strictEqual(l.tipo_movimento, 0);
  assert.strictEqual(l.status, 1);
  assert.strictEqual(l.conta_id, 13);
  assert.strictEqual(l.cobranca_id, 'dev-1');
  assert.strictEqual(l.data_competencia, '2026-10-02');
  assert.strictEqual(l.data_vencimento, '2026-10-02');
  assert.strictEqual(l.data_pagamento, '2026-10-02');
  assert.ok(/tarifa/i.test(l.descricao), 'as telas excluem tarifa por /tarifa/ — precisa manter a palavra');
  assert.deepStrictEqual(db.fin_lancamento_categoria.map(c => [c.lancamento_id, c.categoria_id, c.valor]), [[l.id, 8946, 1.99]]);

  // Sem devedor: nome vem do cliente do Asaas.
  await T.garantirTarifaDoPagamento({ payment: { ...pix, id: 'pay_sem' }, paymentId: 'pay_sem', devedor: null });
  assert.strictEqual(db.fin_lancamento[1].descricao, 'Tarifa Asaas (Pix) — Cliente Do Asaas');
  assert.strictEqual(db.fin_lancamento[1].cobranca_id, null);

  // 4 + 5 — extrato: a PAYMENT_FEE de pay_pix já existe (mesma chave) → não duplica;
  // Pix enviado pega o favorecido da TRANSFER irmã; mensageria o nome da descrição;
  // a de setembro (antes do corte) fica de fora.
  extrato = [
    { id: 'ftn_1', type: 'PAYMENT_FEE', value: -1.99, date: '2026-10-02', paymentId: 'pay_pix', description: 'Taxa do Pix - fatura nr. 1 Fulana de Tal' },
    { id: 'ftn_2', type: 'TRANSFER', value: -8212.5, date: '2026-10-03', transferId: 'tr-1', description: 'Transação via Pix com chave para CREDOR EXEMPLO LTDA' },
    { id: 'ftn_3', type: 'TRANSFER_FEE', value: -2, date: '2026-10-03', transferId: 'tr-1', description: 'Taxa para Pix com chave' },
    { id: 'ftn_4', type: 'PAYMENT_MESSAGING_NOTIFICATION_FEE', value: -0.89, date: '2026-10-04', paymentId: 'pay_msg', description: 'Taxa de mensageria - fatura nr. 2 Beltrano Silva' },
    { id: 'ftn_5', type: 'PAYMENT_FEE', value: -1.99, date: '2026-10-04', paymentId: 'pay_boleto2', description: 'Taxa de boleto - fatura nr. 3 Ciclano Souza' },
    { id: 'ftn_0', type: 'TRANSFER_FEE', value: -2, date: '2026-09-29', transferId: 'tr-0', description: 'Taxa para Pix com chave' },
    { id: 'ftn_9', type: 'PAYMENT_RECEIVED', value: 506, date: '2026-10-02', paymentId: 'pay_pix', description: 'Cobrança recebida' },
  ];
  const plano = T.planejarTarifas(extrato);
  assert.deepStrictEqual(plano.map(p => [p.rotulo, p.nome, p.valor, p.data]), [
    ['Pix', 'Fulana de Tal', 1.99, '2026-10-02'],
    ['Pix enviado', 'CREDOR EXEMPLO LTDA', 2, '2026-10-03'],
    ['mensageria', 'Beltrano Silva', 0.89, '2026-10-04'],
    ['boleto', 'Ciclano Souza', 1.99, '2026-10-04'],
  ]);
  assert.strictEqual(plano[0].chave, T.marcadorPagamento('pay_pix'), 'cron e webhook usam a mesma chave');

  const antesSync = db.fin_lancamento.length;
  const s1 = await T.sincronizarTarifasAsaas({ desde: '2026-09-30', dias: 60 });
  assert.strictEqual(s1.ja_lancadas, 1, 'a do webhook não é relançada');
  assert.strictEqual(s1.lancadas.length, 3, JSON.stringify(s1));
  assert.strictEqual(db.fin_lancamento.length, antesSync + 3);
  const descr = db.fin_lancamento.slice(antesSync).map(x => [x.descricao, x.valor, x.data_pagamento]);
  assert.deepStrictEqual(descr, [
    ['Tarifa Asaas (Pix enviado) — CREDOR EXEMPLO LTDA', -2, '2026-10-03'],
    ['Tarifa Asaas (mensageria) — Beltrano Silva', -0.89, '2026-10-04'],
    ['Tarifa Asaas (boleto) — Ciclano Souza', -1.99, '2026-10-04'],
  ]);

  // Cron de novo no dia seguinte: nada novo.
  const s2 = await T.sincronizarTarifasAsaas({ desde: '2026-09-30', dias: 60 });
  assert.strictEqual(s2.lancadas.length, 0);
  assert.strictEqual(db.fin_lancamento.length, antesSync + 3);

  // Webhook atrasado da pay_boleto2 depois do cron: vê a chave e não duplica.
  const tarde = await T.garantirTarifaDoPagamento({ paymentId: 'pay_boleto2',
    payment: { id: 'pay_boleto2', value: 100, netValue: 98.01, billingType: 'BOLETO', paymentDate: '2026-10-03', creditDate: '2026-10-04' } });
  assert.strictEqual(tarde.skip, 'ja_lancada');

  // O webhook chama o helper (e o cron o sincronizador) — guarda contra remoção.
  const fs = require('fs'), path = require('path');
  const pr = fs.readFileSync(path.join(__dirname, '..', 'api', '_processar-recebimento.js'), 'utf8');
  assert.ok(pr.includes('garantirTarifaDoPagamento({ payment, paymentId, devedor })'));
  const cron = fs.readFileSync(path.join(__dirname, '..', 'api', 'cron-regua.js'), 'utf8');
  assert.ok(cron.includes('sincronizarTarifasAsaas({ dry })'));

  console.log('F-52 ok — tarifas Asaas automáticas e idempotentes');
})().catch(e => { console.error(e); process.exit(1); });
