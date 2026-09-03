/*
 * Teste F-27 — acordo em faixas de parcelas emite 1 série de boleto por faixa,
 * com o valor certo, no lugar de 1 série só com o valor médio errado.
 *
 * O caso: PR "Acordo em faixas de parcelas (blocos)" — o modal Registrar Acordo
 * passou a aceitar mais de uma faixa de valor (ex.: entrada + 3x R$300 + 12x
 * R$400 — o pedido original era simular um acordo assim). Sem mexer em
 * api/_emitir-acordo.js, a emissão continuaria montando UMA série
 * installmentCount+totalValue pro acordo inteiro — e o Asaas SEMPRE divide o
 * totalValue igualmente pelas parcelas, então um acordo de 3x300+12x400
 * (R$5.700 em 15x) sairia como 15 boletos de ~R$380 cada. Certo na tela,
 * errado no boleto de verdade.
 *
 * Este teste roda o handler de api/_emitir-acordo.js de ponta a ponta com
 * Asaas/Supabase/Z-API MOCKADOS (sem tocar rede nem produção — não há
 * credencial de Asaas/sandbox neste ambiente, e não devem entrar num teste
 * automatizado mesmo quando houver) e confere:
 *   1. Uma chamada POST /payments por faixa, cada uma com installmentCount e
 *      totalValue da FAIXA (não do acordo inteiro), e a mesma
 *      externalReference=acordo.id em todas — é por esse campo que
 *      api/_processar-recebimento.js resolve o acordo no webhook.
 *   2. As parcelas previstas no Financeiro (fin_lancamento) numeradas em
 *      sequência contínua (1..15) através das faixas, com total_parcelas=15.
 *   3. metadata grava asaas_series (uma entrada por faixa) e
 *      asaas_installment_ids (usado por api/_boletos-para-lancamentos.js para
 *      não perder o vínculo dos boletos das faixas 2+), mantendo os campos
 *      singulares antigos apontando pra 1ª faixa (compatibilidade).
 *   4. Acordo de faixa ÚNICA (o caso de hoje, praticamente todo acordo
 *      existente) continua emitindo 1 série só, do jeito que sempre emitiu —
 *      esta feature não pode mudar o comportamento de quem não usa faixas.
 *
 * Como rodar:
 *   node test/f27_acordo_blocos_emissao.test.js
 */
'use strict';

const path = require('path');
const assert = require('assert');

let falhas = 0;
function checa(nome, fn) {
  try { fn(); console.log('  ok   ' + nome); }
  catch (e) { falhas++; console.log('  FALHA ' + nome + '\n        ' + e.message); }
}

console.log('\nF-27 · acordo em faixas emite 1 série de boleto por faixa, com o valor certo\n');

const API_DIR = path.join(__dirname, '..', 'api');

function addMonthsISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1 + n, d);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

// ── Monta um acordo fixture igual ao que index.html: salvarAcordo() gera para
// entrada R$250 (10/09) + faixa 3x R$300 + faixa 12x R$400 (16 parcelas: 1
// entrada + 15) — o caso que motivou a feature.
function acordoComBlocos() {
  const venc1 = '2026-09-10';
  const parcelas = [{ id: 'p0', numero: 0, valor: 250, vencimento: venc1, pago: false, tipo: 'entrada' }];
  for (let i = 0; i < 3; i++) parcelas.push({ id: 'p' + (i + 1), numero: i + 1, valor: 300, vencimento: addMonthsISO(venc1, i + 1), pago: false, bloco: 1 });
  for (let i = 0; i < 12; i++) parcelas.push({ id: 'q' + (i + 1), numero: 4 + i, valor: 400, vencimento: addMonthsISO(venc1, 4 + i), pago: false, bloco: 2 });
  return {
    id: 'ac-teste-blocos-1',
    devedor_id: 'dev-teste-1',
    cobranca_id: 'dev-teste-1',
    status: 'ativo',
    parcelas,
    valor_total: 5950,
    valor_entrada: 250,
    num_parcelas: 15,
    data_primeiro_venc: venc1,
    metadata: { obs: 'teste', blocos: [{ qtd: 3, valor: 300 }, { qtd: 12, valor: 400 }] },
  };
}

// ── Acordo "de sempre": 1 faixa só (equivalente a nenhuma faixa) — tem que
// emitir exatamente como antes desta feature.
function acordoSemBlocos() {
  const venc1 = '2026-09-10';
  const parcelas = [];
  for (let i = 0; i < 5; i++) parcelas.push({ id: 'r' + (i + 1), numero: i + 1, valor: 280, vencimento: addMonthsISO(venc1, i), pago: false });
  return {
    id: 'ac-teste-simples-1',
    devedor_id: 'dev-teste-2',
    cobranca_id: 'dev-teste-2',
    status: 'ativo',
    parcelas,
    valor_total: 1400,
    valor_entrada: 0,
    num_parcelas: 5,
    data_primeiro_venc: venc1,
    metadata: {},
  };
}

const devedorFixture = (id, nome) => ({ id, nome, telefone: '5545999998888', asaas_customer_id: null, doc: '00000000000' });

// ── Roda o handler contra UM acordo fixture, com Asaas/Supabase/Z-API
// mockados via require.cache (nunca toca rede). Retorna tudo que os mocks
// capturaram, pra o teste inspecionar.
async function rodarEmissao(acordo, devNome) {
  const calls = { asaas: [], sb: [], zapi: [] };
  const installmentMeta = {}; // installmentId -> { qtd, valor, due }
  let seq = 0;

  function stub(rel, exportsObj) {
    const resolved = require.resolve(path.join(API_DIR, rel));
    delete require.cache[resolved];
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
  }

  stub('_auth.js', {
    applyCors: () => {},
    requireUser: async () => ({ id: 'user-teste' }),
  });
  stub('_data.js', {
    addDiasBR: () => '2099-01-01',
  });
  stub('_zapi.js', {
    zapiSendText: async (tel, msg) => { calls.zapi.push({ tel, msg }); return { messageId: 'zap-fake-' + (++seq) }; },
  });
  stub('_asaas.js', {
    ensureAsaasCustomer: async () => ({ customerId: 'cus-fake-1', created: false }),
    asaasReq: async (method, urlPath, data) => {
      calls.asaas.push({ method, urlPath, data });
      if (method === 'POST' && urlPath === '/payments') {
        seq++;
        const isSerie = !!data.installmentCount;
        const instId = isSerie ? 'inst-fake-' + seq : null;
        if (isSerie) installmentMeta[instId] = { qtd: data.installmentCount, valor: data.totalValue / data.installmentCount, due: data.dueDate };
        return {
          id: 'pay-fake-' + seq,
          installment: instId,
          invoiceUrl: `https://sandbox.asaas.com/i/fake-${seq}`,
          bankSlipUrl: null,
          value: isSerie ? data.totalValue / data.installmentCount : data.value,
          dueDate: data.dueDate,
          installmentNumber: 1,
        };
      }
      if (method === 'GET' && urlPath.startsWith('/payments?installment=')) {
        const instId = decodeURIComponent(urlPath.match(/installment=([^&]+)/)[1]);
        const m = installmentMeta[instId] || { qtd: 1, valor: 0, due: '2026-01-01' };
        const data2 = [];
        for (let i = 0; i < m.qtd; i++) {
          data2.push({ id: `${instId}-p${i + 1}`, installmentNumber: i + 1, value: m.valor, dueDate: addMonthsISO(m.due, i) });
        }
        return { data: data2 };
      }
      return {};
    },
  });
  stub('_sb.js', {
    sbFetch: async (pathQuery, opts) => {
      const method = (opts && opts.method) || 'GET';
      const body = opts && opts.body ? JSON.parse(opts.body) : undefined;
      calls.sb.push({ pathQuery, method, body });
      if (pathQuery.startsWith('acordos?') && pathQuery.includes('select=*')) return [acordo];
      if (pathQuery.startsWith('acordos?')) return [{ id: acordo.id }]; // claim + patches
      if (pathQuery.startsWith('devedores?')) return [devedorFixture(acordo.devedor_id, devNome)];
      if (pathQuery.startsWith('cobrancas?')) return [];
      if (pathQuery.startsWith('fin_lancamento')) return [];
      if (pathQuery.startsWith('devedor_eventos')) return [];
      return [];
    },
  });

  process.env.EMIT_ACORDO_SECRET = 'segredo-teste';
  process.env.AUTO_EMIT_ACORDO = 'on'; // sem isso o handler pula a emissão (trava anti-duplicação com o n8n legado)
  const handlerPath = path.join(API_DIR, '_emitir-acordo.js');
  delete require.cache[require.resolve(handlerPath)];
  const handler = require(handlerPath);

  const req = { method: 'POST', headers: { 'x-emit-secret': 'segredo-teste' }, query: {}, body: { acordo_id: acordo.id } };
  const res = {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
    setHeader() {},
  };
  await handler(req, res);
  return { res, calls };
}

(async () => {
  // ── 1. Acordo em faixas: 1 série de boleto por faixa, valor certo ──────────
  const { res: res1, calls: calls1 } = await rodarEmissao(acordoComBlocos(), 'Devedora Teste Blocos');

  checa('responde 200 com 2 séries e 15 parcelas', () => {
    assert.strictEqual(res1.statusCode, 200, 'status: ' + JSON.stringify(res1.body));
    assert.strictEqual(res1.body.series, 2);
    assert.strictEqual(res1.body.parcelas, 15);
    assert.strictEqual(res1.body.total, 5700); // 5950 - 250 de entrada
  });

  const postsPayments = calls1.asaas.filter((c) => c.method === 'POST' && c.urlPath === '/payments');
  checa('emite exatamente 2 séries no Asaas — 1 por faixa, não 1 pro acordo inteiro', () => {
    assert.strictEqual(postsPayments.length, 2, 'chamadas POST /payments: ' + postsPayments.length);
  });
  checa('faixa 1 = 3 parcelas de R$300 (totalValue 900) — NÃO o valor médio das 15', () => {
    const p = postsPayments[0].data;
    assert.strictEqual(p.installmentCount, 3);
    assert.strictEqual(p.totalValue, 900);
    assert.strictEqual(p.dueDate, '2026-10-10');
  });
  checa('faixa 2 = 12 parcelas de R$400 (totalValue 4800) — NÃO o valor médio das 15', () => {
    const p = postsPayments[1].data;
    assert.strictEqual(p.installmentCount, 12);
    assert.strictEqual(p.totalValue, 4800);
    assert.strictEqual(p.dueDate, '2027-01-10');
  });
  checa('as duas séries usam o MESMO externalReference=acordo.id — é o que o webhook resolve', () => {
    assert.strictEqual(postsPayments[0].data.externalReference, 'ac-teste-blocos-1');
    assert.strictEqual(postsPayments[1].data.externalReference, 'ac-teste-blocos-1');
  });

  const linhasFin = (calls1.sb.find((c) => c.pathQuery.startsWith('fin_lancamento')) || {}).body || [];
  checa('grava 15 parcelas previstas no Financeiro (1 por parcela, através das 2 faixas)', () => {
    assert.strictEqual(linhasFin.length, 15, 'linhas: ' + linhasFin.length);
  });
  checa('numeração contínua 1..15 através das faixas, total_parcelas=15 em todas', () => {
    const nums = linhasFin.map((l) => l.numero_parcela).sort((a, b) => a - b);
    assert.deepStrictEqual(nums, Array.from({ length: 15 }, (_, i) => i + 1));
    assert.ok(linhasFin.every((l) => l.total_parcelas === 15));
  });
  checa('valor de cada lançamento bate com a faixa (300 nas 3 primeiras, 400 nas 12 seguintes)', () => {
    const porNumero = {}; linhasFin.forEach((l) => { porNumero[l.numero_parcela] = l.valor; });
    for (let n = 1; n <= 3; n++) assert.strictEqual(porNumero[n], 300, `parcela ${n} deveria ser 300, veio ${porNumero[n]}`);
    for (let n = 4; n <= 15; n++) assert.strictEqual(porNumero[n], 400, `parcela ${n} deveria ser 400, veio ${porNumero[n]}`);
  });

  const patchMeta = calls1.sb.find((c) => c.method === 'PATCH' && c.body && c.body.metadata && c.body.metadata.asaas_series);
  checa('metadata grava asaas_series (1 entrada por faixa) e asaas_installment_ids', () => {
    assert.ok(patchMeta, 'não achei o PATCH com asaas_series');
    assert.strictEqual(patchMeta.body.metadata.asaas_series.length, 2);
    assert.strictEqual(patchMeta.body.metadata.asaas_installment_ids.length, 2);
    assert.strictEqual(patchMeta.body.metadata.asaas_series[0].total, 900);
    assert.strictEqual(patchMeta.body.metadata.asaas_series[1].total, 4800);
  });
  checa('campos singulares (compat) apontam pra 1ª faixa, não ficam nulos nem misturados', () => {
    assert.strictEqual(patchMeta.body.metadata.asaas_installment_id, patchMeta.body.metadata.asaas_series[0].installment_id);
    assert.strictEqual(patchMeta.body.metadata.asaas_invoice_url, patchMeta.body.metadata.asaas_series[0].invoice_url);
  });

  checa('WhatsApp lista as 2 faixas (não manda só o link da 1ª e esconde o resto do acordo)', () => {
    assert.strictEqual(calls1.zapi.length, 1);
    assert.ok(/Faixa 1/.test(calls1.zapi[0].msg) && /Faixa 2/.test(calls1.zapi[0].msg), 'mensagem: ' + calls1.zapi[0].msg);
  });

  // ── 2. Acordo sem faixas (o caminho de sempre): continua emitindo 1 série só ─
  const { res: res2, calls: calls2 } = await rodarEmissao(acordoSemBlocos(), 'Devedor Teste Simples');
  const postsPayments2 = calls2.asaas.filter((c) => c.method === 'POST' && c.urlPath === '/payments');

  checa('acordo de faixa única emite 1 série só, exatamente como antes desta feature', () => {
    assert.strictEqual(res2.statusCode, 200, 'status: ' + JSON.stringify(res2.body));
    assert.strictEqual(res2.body.series, 1);
    assert.strictEqual(postsPayments2.length, 1);
    assert.strictEqual(postsPayments2[0].data.installmentCount, 5);
    assert.strictEqual(postsPayments2[0].data.totalValue, 1400);
  });
  checa('acordo de faixa única manda 1 link só no WhatsApp (mensagem simples, não a de múltiplas faixas)', () => {
    assert.strictEqual(calls2.zapi.length, 1);
    assert.ok(!/Faixa 1/.test(calls2.zapi[0].msg), 'não deveria usar o formato de faixas: ' + calls2.zapi[0].msg);
  });

  console.log(falhas ? `\nF-27 FALHOU — ${falhas} checagem(ns).\n` : '\nF-27 ok — acordo em faixas emite 1 série por faixa com o valor certo, e o caminho de faixa única não mudou.\n');
  process.exitCode = falhas ? 1 : 0;
})();
