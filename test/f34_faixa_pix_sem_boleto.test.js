/*
 * Teste F-34 — faixa "via PIX" não gera boleto no Asaas.
 *
 * O caso (pedido do Gustavo, 12/09/2026): a entrada / parcela única de um acordo
 * é quase sempre paga na hora por PIX. Até aqui o Termo zerava valor_entrada e
 * tratava a entrada como 1ª faixa — e a emissão (api/_emitir-acordo.js) mandava
 * boleto para ela também. Agora cada faixa tem meio ∈ {boleto, pix}
 * (metadata.blocos[].meio; parcelas[].meio) e:
 *   1. Faixa PIX é PULADA na emissão — só as faixas boleto viram série no Asaas.
 *   2. A numeração das parcelas previstas no Financeiro continua contínua
 *      (1 PIX + 12 boletos → boletos numerados 2..13, total_parcelas=13).
 *   3. valor_boletos/total na resposta = só o que foi ao Asaas.
 *   4. Acordo 100% PIX: nenhum POST /payments, acordo marcado como emitido
 *      (metadata.boletos_emitidos + sem_boleto) para não ficar pendente para sempre.
 *   5. Acordo sem meio nenhum (todos os existentes) emite exatamente como antes.
 *
 * Como rodar: node test/f34_faixa_pix_sem_boleto.test.js
 */
'use strict';

const path = require('path');
const assert = require('assert');

let falhas = 0;
function checa(nome, fn) {
  try { fn(); console.log('  ok   ' + nome); }
  catch (e) { falhas++; console.log('  FALHA ' + nome + '\n        ' + e.message); }
}

console.log('\nF-34 · faixa via PIX não gera boleto no Asaas\n');

const API_DIR = path.join(__dirname, '..', 'api');

function addMonthsISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1 + n, d);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

// ── Monta um acordo fixture igual ao que index.html: salvarAcordo() gera para
// entrada R$250 (10/09) + faixa 3x R$300 + faixa 12x R$400 (16 parcelas: 1
// entrada + 15) — o caso que motivou a feature.
function _naoUsado() {
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
function _naoUsado2() {
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


function acordoEntradaPixMaisBoletos() {
  const venc1 = '2026-09-12';
  const parcelas = [{ id: 'e1', numero: 0, valor: 500, vencimento: venc1, pago: false, bloco: 1, meio: 'pix' }];
  for (let i = 0; i < 12; i++) parcelas.push({ id: 'b' + (i + 1), numero: 1 + i, valor: 300, vencimento: addMonthsISO(venc1, 1 + i), pago: false, bloco: 2, meio: 'boleto' });
  return {
    id: 'ac-teste-pix-1', devedor_id: 'dev-pix-1', cobranca_id: 'dev-pix-1', status: 'ativo', parcelas,
    valor_total: 4100, valor_entrada: 0, num_parcelas: 13, data_primeiro_venc: venc1,
    metadata: { obs: '', blocos: [{ qtd: 1, valor: 500, meio: 'pix' }, { qtd: 12, valor: 300, meio: 'boleto' }] },
  };
}
function acordoSoPix() {
  return {
    id: 'ac-teste-pix-2', devedor_id: 'dev-pix-2', cobranca_id: 'dev-pix-2', status: 'ativo',
    parcelas: [{ id: 'u1', numero: 0, valor: 4300, vencimento: '2026-09-12', pago: false, bloco: 1, meio: 'pix' }],
    valor_total: 4300, valor_entrada: 0, num_parcelas: 1, data_primeiro_venc: '2026-09-12',
    metadata: { obs: '', blocos: [{ qtd: 1, valor: 4300, meio: 'pix' }] },
  };
}
function acordoLegadoSemMeio() {
  const venc1 = '2026-09-12';
  const parcelas = [];
  for (let i = 0; i < 5; i++) parcelas.push({ id: 'r' + (i + 1), numero: i + 1, valor: 280, vencimento: addMonthsISO(venc1, i), pago: false });
  return { id: 'ac-teste-legado', devedor_id: 'dev-leg', cobranca_id: 'dev-leg', status: 'ativo', parcelas,
    valor_total: 1400, valor_entrada: 0, num_parcelas: 5, data_primeiro_venc: venc1, metadata: {} };
}

(async () => {
  // ── 1. entrada PIX + 12 boletos ─────────────────────────────────────────
  const { res: r1, calls: c1 } = await rodarEmissao(acordoEntradaPixMaisBoletos(), 'Devedora PIX+Boleto');
  const posts1 = c1.asaas.filter((c) => c.method === 'POST' && c.urlPath === '/payments');
  checa('faixa PIX não vira série: exatamente 1 POST /payments (só a faixa boleto)', () => {
    assert.strictEqual(r1.statusCode, 200, JSON.stringify(r1.body));
    assert.strictEqual(posts1.length, 1);
    assert.strictEqual(posts1[0].data.installmentCount, 12);
    assert.strictEqual(posts1[0].data.totalValue, 3600);
  });
  checa('resposta/valor_boletos = só o que foi ao Asaas (3600), não os 4100 do acordo', () => {
    assert.strictEqual(r1.body.total, 3600);
    assert.strictEqual(r1.body.series, 1);
    const patch = c1.sb.filter((c) => c.method === 'PATCH' && c.body && c.body.metadata && c.body.metadata.boletos_emitidos).pop();
    assert.ok(patch, 'PATCH com boletos_emitidos');
    assert.strictEqual(patch.body.metadata.valor_boletos, 3600);
    assert.strictEqual(patch.body.metadata.asaas_series.length, 1);
    assert.strictEqual(patch.body.metadata.asaas_series[0].bloco, 2);
  });
  checa('previstas no Financeiro: 12 linhas numeradas 2..13 de 13 (a PIX é a nº 1, sem boleto)', () => {
    const fin = c1.sb.find((c) => c.pathQuery.startsWith('fin_lancamento') && c.method === 'POST');
    assert.ok(fin, 'POST fin_lancamento');
    const nums = fin.body.map((l) => l.numero_parcela);
    assert.deepStrictEqual(nums, [2,3,4,5,6,7,8,9,10,11,12,13]);
    assert.ok(fin.body.every((l) => l.total_parcelas === 13));
    assert.ok(fin.body.every((l) => l.valor === 300));
  });

  // ── 2. 100% PIX ──────────────────────────────────────────────────────────
  const { res: r2, calls: c2 } = await rodarEmissao(acordoSoPix(), 'Devedora Só PIX');
  checa('acordo 100% PIX: nenhum POST /payments no Asaas', () => {
    assert.strictEqual(r2.statusCode, 200, JSON.stringify(r2.body));
    assert.strictEqual(c2.asaas.filter((c) => c.method === 'POST').length, 0);
    assert.strictEqual(r2.body.series, 0);
    assert.ok(/PIX/.test(r2.body.skipped || ''));
  });
  checa('acordo 100% PIX fica marcado como emitido (boletos_emitidos + sem_boleto) e sem "emitindo" pendurado', () => {
    const patch = c2.sb.filter((c) => c.method === 'PATCH' && c.body && c.body.metadata).pop();
    assert.ok(patch, 'PATCH final');
    assert.strictEqual(patch.body.metadata.boletos_emitidos, true);
    assert.ok(/PIX/.test(patch.body.metadata.sem_boleto));
    assert.strictEqual(patch.body.metadata.emitindo, undefined);
    assert.strictEqual(c2.zapi.length, 0, 'não manda WhatsApp de boleto');
  });

  // ── 3. legado sem meio ──────────────────────────────────────────────────
  const { res: r3, calls: c3 } = await rodarEmissao(acordoLegadoSemMeio(), 'Devedor Legado');
  checa('acordo sem meio (todos os existentes) emite 1 série de 5x como sempre', () => {
    assert.strictEqual(r3.statusCode, 200, JSON.stringify(r3.body));
    const posts = c3.asaas.filter((c) => c.method === 'POST' && c.urlPath === '/payments');
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].data.installmentCount, 5);
    assert.strictEqual(posts[0].data.totalValue, 1400);
    assert.strictEqual(r3.body.total, 1400);
  });

  // ── 4. motor do termo: frase "via PIX" e complemento da cláusula 2 ──────
  const vm = require('vm');
  const fs = require('fs');
  const ctx = { window: {} }; ctx.global = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'templates', 'termo-engine.js'), 'utf8'), ctx);
  const E = ctx.window.TermoEngine || ctx.TermoEngine;
  checa('frasePagamento diz "via PIX" na faixa PIX e nada nas faixas boleto', () => {
    const f = E.frasePagamento({ vencimento: '2026-09-12', faixas: [{ qtd: 1, valor: 500, meio: 'pix' }, { qtd: 12, valor: 300, meio: 'boleto' }] });
    assert.ok(/quinhentos reais\)<\/strong>, via PIX, seguidas de/.test(f), f);
    assert.ok(!/300,00<\/strong> cada, via PIX/.test(f), f);
  });
  checa('fraseEntregaBoletos: só PIX → chave e comprovante, sem "boletos"; misto → as duas; sem PIX → só boletos', () => {
    const so = E.fraseEntregaBoletos({ faixas: [{ qtd: 1, valor: 4300, meio: 'pix' }], pixChave: 'ccobrasq@gmail.com' }, 'F');
    assert.ok(/ccobrasq@gmail\.com/.test(so) && !/boletos/i.test(so), so);
    const misto = E.fraseEntregaBoletos({ faixas: [{ qtd: 1, valor: 500, meio: 'pix' }, { qtd: 12, valor: 300 }], pixChave: 'x@y' }, 'F');
    assert.ok(/boletos/i.test(misto) && /x@y/.test(misto), misto);
    const sem = E.fraseEntregaBoletos({ faixas: [{ qtd: 12, valor: 300 }] }, 'F');
    assert.ok(/boletos/i.test(sem) && !/PIX/.test(sem), sem);
  });

  console.log(falhas ? `\nF-34 FALHOU — ${falhas} checagem(ns).\n` : '\nF-34 ok — faixa PIX fica fora do Asaas; boleto continua igual.\n');
  process.exitCode = falhas ? 1 : 0;
})();
