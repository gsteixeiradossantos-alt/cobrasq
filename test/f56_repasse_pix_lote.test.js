/*
 * Teste F-56 (repasse) — várias parcelas do mesmo devedor saem num PIX só.
 *
 * Contexto (30/09/2026): três parcelas da Fernanda da Silva à Kalayame (3/9, 8/9 e 9/9,
 * R$ 406,00 cada) estavam selecionadas, e "Repassar 3 ao credor" abria três modais =
 * três PIX, três tarifas, três comprovantes. O Gustavo pediu um PIX com a soma.
 *
 * O que se prova aqui, com banco e Asaas falsos:
 *   - UM /transfers com a soma e a descrição "3 - Fernanda da Silva" (só a 1ª parcela, pedido de 30/09);
 *   - as três operações ficam com o MESMO transfer; as três saídas são baixadas;
 *   - UMA mensagem ao credor citando as três parcelas e UMA linha na ficha, com a soma;
 *   - Asaas ainda processando → o webhook conclui o grupo inteiro, e a reentrega é
 *     ignorada; falha no Asaas → o grupo inteiro volta a pendente;
 *   - devedores misturados, parcela já baixada ou teto estourado → nada sai.
 *
 * Como rodar:
 *   node test/f56_repasse_pix_lote.test.js
 */
'use strict';

const path = require('path');
const assert = require('assert');
const Module = require('module');

process.env.EMIT_ACORDO_SECRET = 'segredo-teste';
process.env.SUPABASE_URL = 'https://exemplo.supabase.co';

const RAIZ = path.join(__dirname, '..');

// ── Banco falso: o suficiente de PostgREST (eq, in, is.null, select, limit) ──────────
let db; let seq;
function novoBanco() {
  seq = 100;
  const lanc = (id, parcela, cob, nome) => ({
    id, descricao: `${nome} ${parcela}/9`, valor: -406, tipo_movimento: 0, status: 0,
    cobranca_id: cob, credor_id: null, numero_parcela: parcela, total_parcelas: 9,
  });
  db = {
    fin_lancamento: [
      lanc(11, 3, 'cob-fer', 'Fernanda da Silva'),
      lanc(12, 8, 'cob-fer', 'Fernanda da Silva'),
      lanc(13, 9, 'cob-fer', 'Fernanda da Silva'),
      lanc(21, 2, 'cob-out', 'Outro Devedor'),
    ],
    fin_operacao: [],
    cobrancas: [{ id: 'cob-fer', cliente_id: 'cli-kal' }, { id: 'cob-out', cliente_id: 'cli-kal' }],
    clientes: [{ id: 'cli-kal', nome: 'Kalayame Eletromóveis', telefone: '46999990000', doc: '12345678000199', chave_pix: 'pix@kalayame', metadata: {} }],
    devedores: [{ id: 'cob-fer', nome: 'Fernanda da Silva' }, { id: 'cob-out', nome: 'Outro Devedor' }],
  };
}
function filtrar(rows, qs) {
  let out = rows;
  for (const [k, v] of qs) {
    if (['select', 'limit', 'order'].includes(k)) continue;
    if (v.startsWith('eq.')) { const x = decodeURIComponent(v.slice(3)); out = out.filter(r => String(r[k]) === x); }
    else if (v === 'is.null') out = out.filter(r => r[k] == null);
    else if (v.startsWith('in.(')) { const xs = v.slice(4, -1).split(',').map(decodeURIComponent); out = out.filter(r => xs.includes(String(r[k]))); }
    else if (v.startsWith('like.')) out = [];
  }
  const lim = qs.find(([k]) => k === 'limit');
  return lim ? out.slice(0, +lim[1]) : out;
}
async function sbFetch(caminho, opts = {}) {
  const [tab, q = ''] = caminho.split('?');
  const qs = q ? q.split('&').map(p => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }) : [];
  const metodo = opts.method || 'GET';
  const rows = db[tab] || (db[tab] = []);
  if (metodo === 'GET') return JSON.parse(JSON.stringify(filtrar(rows, qs)));
  if (metodo === 'POST') {
    const r = { id: `op-${++seq}`, repasse_asaas_transfer_id: null, ...JSON.parse(opts.body) };
    rows.push(r); return [r];
  }
  if (metodo === 'PATCH') {
    const alvo = filtrar(rows, qs); const patch = JSON.parse(opts.body);
    alvo.forEach(r => Object.assign(r, patch));
    return JSON.parse(JSON.stringify(alvo));
  }
  throw new Error('método ' + metodo);
}

// ── Asaas, mensagem, ficha e comprovante falsos ──────────────────────────────────────
let transfers; let asaasResposta; let mensagens; let fichas; let teto;
const msgReal = (() => {
  const orig = Module._load;
  Module._load = function (p, pai, m) { if (p === './_sb.js') return { sbFetch }; if (p === './_zapi.js') return {}; return orig(p, pai, m); };
  const x = require(path.join(RAIZ, 'api', '_repasse-msg.js'));
  Module._load = orig; return x;
})();

const originalLoad = Module._load;
Module._load = function (pedido, pai, ehMain) {
  if (pedido === './_auth.js') return { applyCors() {}, requireUser: async () => ({ id: 'user-teste' }) };
  if (pedido === './_sb.js') return { sbFetch };
  if (pedido === './_asaas.js') {
    return {
      asaasReq: async (metodo, rota, corpo) => {
        if (metodo === 'POST' && rota === '/transfers') {
          transfers.push(corpo);
          if (asaasResposta === 'erro') throw new Error('Asaas fora');
          return { id: 'tr_1', status: asaasResposta, transactionReceiptUrl: 'https://asaas/recibo/tr_1' };
        }
        throw new Error('rota inesperada ' + rota);
      },
    };
  }
  if (pedido === './_comprovante.js') return { guardarComprovante: async () => ({ base64: 'UERG', storage_path: 'x/tr_1.pdf', bytes: 3 }) };
  if (pedido === './_comprovante-pdf.js') return { gerarComprovanteRepassePdf: async () => 'UERG', imprimirPaginaAsaasPdf: async () => '' };
  if (pedido === './_repasse-msg.js') {
    return {
      ...msgReal,
      enviarComprovanteCredor: async (a) => { mensagens.push({ ...a, texto: msgReal.msgComprovanteCredor(a) }); return { enviado: true, via: 'zapi' }; },
    };
  }
  if (pedido === './_repasse-ficha.js') {
    return {
      saldoDeCapital: async () => teto,
      devedorPrincipal: async () => ({ doc: '12345678909' }),
      partesDaCobranca: async () => [],
      resolverCobrancaId: async (op) => (op.metadata && op.metadata.cobranca_id) || null,
      registrarRepasseNaFicha: async (a) => { fichas.push(a); return { repasse_id: 'rp-1' }; },
    };
  }
  return originalLoad(pedido, pai, ehMain);
};
const repassar = require(path.join(RAIZ, 'api', '_repassar.js'));
const concluido = require(path.join(RAIZ, 'api', '_repasse-concluido.js'));
Module._load = originalLoad;

function resposta() {
  const r = { code: 0, corpo: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (j) => { r.corpo = j; return r; };
  r.end = () => r;
  r.setHeader = () => {};
  return r;
}
async function chamarRepassar(body) {
  const res = resposta();
  await repassar({ method: 'POST', headers: {}, body }, res);
  return res;
}
async function chamarWebhook(transfer, event) {
  const res = resposta();
  await concluido({ method: 'POST', headers: { 'x-emit-secret': 'segredo-teste' }, body: { event, transfer } }, res);
  return res;
}
function inicio() { novoBanco(); transfers = []; mensagens = []; fichas = []; asaasResposta = 'DONE'; teto = { capital: 5000, enviado: 0, saldo: 5000 }; }

(async () => {
  let ok = 0;
  const caso = async (nome, fn) => { inicio(); await fn(); ok++; console.log('  ✓ ' + nome); };

  await caso('três parcelas, Asaas conclui na hora: um PIX, uma mensagem, uma ficha', async () => {
    const r = await chamarRepassar({ lancamento_ids: [11, 12, 13] });
    assert.strictEqual(r.code, 200, JSON.stringify(r.corpo));
    assert.strictEqual(transfers.length, 1);
    assert.strictEqual(transfers[0].value, 1218);
    assert.strictEqual(transfers[0].description, '3 - Fernanda da Silva');
    assert.strictEqual(r.corpo.valor_total, 1218);
    assert.strictEqual(r.corpo.repasse_status, 'efetuado');
    assert.strictEqual(db.fin_operacao.length, 3);
    assert.ok(db.fin_operacao.every(o => o.repasse_status === 'efetuado' && o.repasse_asaas_transfer_id === 'tr_1'));
    assert.ok(db.fin_lancamento.filter(l => l.id < 20).every(l => l.status === 1 && l.valor_pago === -406));
    assert.strictEqual(db.fin_lancamento.find(l => l.id === 21).status, 0, 'lançamento fora da seleção não pode ser tocado');
    assert.strictEqual(mensagens.length, 1);
    assert.deepStrictEqual(mensagens[0].parcelas, [3, 8, 9]);
    assert.ok(/referente à \*parcela 3 de 9\*/.test(mensagens[0].texto) && !/8 e 9/.test(mensagens[0].texto), mensagens[0].texto);
    assert.strictEqual(fichas.length, 1);
    assert.strictEqual(fichas[0].valor, 1218);
  });

  await caso('Asaas processando: fica preparado; o webhook conclui o grupo e ignora a reentrega', async () => {
    asaasResposta = 'PENDING';
    const r = await chamarRepassar({ lancamento_ids: [11, 12, 13] });
    assert.strictEqual(r.corpo.repasse_status, 'preparado');
    assert.strictEqual(mensagens.length, 0);
    assert.ok(db.fin_lancamento.filter(l => l.id < 20).every(l => l.status === 0));
    const primeira = db.fin_operacao[0].id;
    const w = await chamarWebhook({ id: 'tr_1', status: 'DONE', externalReference: primeira }, 'TRANSFER_DONE');
    assert.strictEqual(w.code, 200, JSON.stringify(w.corpo));
    assert.ok(db.fin_operacao.every(o => o.repasse_status === 'efetuado'));
    assert.ok(db.fin_lancamento.filter(l => l.id < 20).every(l => l.status === 1));
    assert.strictEqual(mensagens.length, 1);
    assert.deepStrictEqual(mensagens[0].parcelas, [3, 8, 9]);
    assert.strictEqual(fichas.length, 1);
    assert.strictEqual(fichas[0].valor, 1218);
    const w2 = await chamarWebhook({ id: 'tr_1', status: 'DONE', externalReference: primeira }, 'TRANSFER_DONE');
    assert.strictEqual(w2.corpo.duplicate, true);
    assert.strictEqual(mensagens.length, 1, 'reentrega do webhook não pode mandar outra mensagem');
  });

  await caso('webhook de falha reabre o grupo inteiro', async () => {
    asaasResposta = 'PENDING';
    await chamarRepassar({ lancamento_ids: [11, 12, 13] });
    await chamarWebhook({ id: 'tr_1', status: 'FAILED', externalReference: db.fin_operacao[0].id }, 'TRANSFER_FAILED');
    assert.ok(db.fin_operacao.every(o => o.repasse_status === 'pendente' && o.repasse_asaas_transfer_id === null));
    assert.strictEqual(mensagens.length, 0);
  });

  await caso('Asaas recusa o PIX: nada fica preso em preparado', async () => {
    asaasResposta = 'erro';
    const r = await chamarRepassar({ lancamento_ids: [11, 12, 13] });
    assert.strictEqual(r.code, 500);
    assert.ok(db.fin_operacao.every(o => o.repasse_status === 'pendente'));
  });

  await caso('devedores diferentes: recusa sem PIX', async () => {
    const r = await chamarRepassar({ lancamento_ids: [11, 21] });
    assert.strictEqual(r.code, 400);
    assert.ok(/devedores diferentes/.test(r.corpo.error));
    assert.strictEqual(transfers.length, 0);
  });

  await caso('parcela já baixada na seleção: recusa sem PIX', async () => {
    db.fin_lancamento.find(l => l.id === 12).status = 1;
    const r = await chamarRepassar({ lancamento_ids: [11, 12, 13] });
    assert.strictEqual(r.code, 409);
    assert.strictEqual(transfers.length, 0);
  });

  await caso('soma passa do capital do caso: recusa sem PIX', async () => {
    teto = { capital: 1000, enviado: 0, saldo: 1000 };
    const r = await chamarRepassar({ lancamento_ids: [11, 12, 13] });
    assert.strictEqual(r.code, 409);
    assert.strictEqual(r.corpo.teto_capital, true);
    assert.strictEqual(transfers.length, 0);
  });

  await caso('uma parcela só continua no caminho de sempre', async () => {
    const r = await chamarRepassar({ lancamento_id: 11 });
    assert.strictEqual(r.code, 200, JSON.stringify(r.corpo));
    assert.strictEqual(transfers[0].value, 406);
    assert.strictEqual(transfers[0].description, '3 - Fernanda da Silva');
    assert.strictEqual(mensagens.length, 1);
    assert.ok(!mensagens[0].parcelas);
  });

  // Cobrança cadastrada com partes: id da cobrança ≠ id do devedor (Deivid Ghizzo, 30/09/2026).
  await caso('cobrança com partes: devedor_id vem do devedor principal, não do id da cobrança', async () => {
    db.fin_lancamento.push({ id: 31, descricao: 'Deivid Ghizzo 1/1', valor: -1508.99, tipo_movimento: 0, status: 0, cobranca_id: 'cob-dei', credor_id: null, numero_parcela: 1, total_parcelas: 1 });
    db.cobrancas.push({ id: 'cob-dei', cliente_id: 'cli-kal' });
    db.devedores.push({ id: 'dev-dei', nome: 'Deivid Ghizzo' });
    db.cobranca_partes = [{ cobranca_id: 'cob-dei', devedor_id: 'dev-dei', principal: true }];
    const r = await chamarRepassar({ lancamento_id: 31 });
    assert.strictEqual(r.code, 200, JSON.stringify(r.corpo));
    assert.strictEqual(db.fin_operacao[0].devedor_id, 'dev-dei');
  });

  await caso('cobrança sem devedor nenhum: erro claro e nenhum PIX', async () => {
    db.fin_lancamento.push({ id: 32, descricao: 'Sem Cadastro 1/1', valor: -100, tipo_movimento: 0, status: 0, cobranca_id: 'cob-sem', credor_id: null, numero_parcela: 1, total_parcelas: 1 });
    db.cobrancas.push({ id: 'cob-sem', cliente_id: 'cli-kal' });
    const r = await chamarRepassar({ lancamento_id: 32 });
    assert.strictEqual(r.code, 400, JSON.stringify(r.corpo));
    assert.ok(/cobrança de Sem Cadastro não tem devedor cadastrado/.test(r.corpo.error), r.corpo.error);
    assert.strictEqual(transfers.length, 0);
    assert.strictEqual(db.fin_operacao.length, 0);
  });

  console.log(`\nF-56: ${ok} casos OK`);
})().catch(e => { console.error('✗', e.message); process.exit(1); });
