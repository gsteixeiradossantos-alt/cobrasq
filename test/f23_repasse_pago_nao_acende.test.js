/*
 * Teste F-23 — repasse que já saiu não é "a repassar".
 *
 * O repasse 1/3 da Saine Americo Ribeiro (R$ 171,00, pago em 17/08/2026) exibia o marcador
 * ↗. A operação que o dá por `efetuado` tem `recebido_em` NULO, e a consulta de operações
 * de Movimentações filtra por esse campo dentro do período — então ela nunca era carregada,
 * o `efetuado` ficava invisível, e a linha caía na terceira origem (carteira pela cobrança).
 *
 * Perseguir a operação consertaria só esse caminho. A QUITAÇÃO é o fato: qualquer origem
 * que diga "a repassar" sobre linha já paga está errada, venha de onde vier. O corte entrou
 * na primeira linha da função, ao lado do corte de receita.
 *
 * Quarto caso da mesma família — receita com carteira (#615), tarifa (#616), receita com
 * operação (#618) e agora saída paga. Todos eram origens que não protegiam o próprio caso.
 *
 * Como rodar:
 *   node test/f23_repasse_pago_nao_acende.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function corta(marca, fim) {
  const i = HTML.indexOf(marca);
  assert.ok(i >= 0, `não achei no index.html: ${marca}`);
  const j = HTML.indexOf(fim, i + marca.length);
  assert.ok(j > i, `não achei o fim de ${marca}`);
  return HTML.slice(i, j + fim.length);
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  corta('const _finEhTarifa', '\n') + corta('const _finLancQuitado', '\n')
  + corta('function _finRepasseTemLastroApuravel(l){', '\n}')
  + corta('function _finLancEhRepasse(l, ctx){', '\n}')
  + 'this._eh = _finLancEhRepasse;',
  ctx
);
const eh = ctx._eh;

// A linha real da Saine: saída paga, com credor resolvido pela cobrança, e SEM a operação
// carregada — que é exatamente o estado em que ela acendia.
const PAGO = { id: 124800, tipo_movimento: 0, status: 1, data_pagamento: '2026-08-17',
               conciliado: false, credor_id: 'sos', descricao: 'Saine Americo Ribeiro 1/3' };
const tela = { opsByLanc: {}, cedMap: {}, liberadas: null,
               credorPorLanc: { 124800: 'S.O.S Animal' } };
assert.strictEqual(eh(PAGO, tela), false, 'repasse já pago não pode contar como "a repassar"');

// As três formas de estar quitado fecham a porta — a tela usa as três em _finLancSit.
const base = { id: 5, tipo_movimento: 0, credor_id: 'x', descricao: 'repasse' };
const t5 = { opsByLanc: {}, cedMap: {}, liberadas: null, credorPorLanc: { 5: 'Credor' } };
assert.strictEqual(eh({ ...base, status: 1 }, t5), false, 'status pago fecha');
assert.strictEqual(eh({ ...base, status: 0, data_pagamento: '2026-08-17' }, t5), false, 'data de pagamento fecha');
assert.strictEqual(eh({ ...base, status: 0, conciliado: true }, t5), false, 'conciliado fecha');

// E o controle: o MESMO repasse em aberto continua acendendo.
assert.strictEqual(eh({ ...base, status: 0 }, t5), true, 'repasse em aberto continua acendendo');

// Fecha por TODAS as origens, não só pela carteira — inclusive com a operação carregada
// dizendo "pendente", que é o estado contraditório que o fixture do F-07 tinha.
assert.strictEqual(
  eh({ ...base, status: 1 }, { opsByLanc: { 5: { repasse_status: 'pendente' } },
      cedMap: {}, credorPorLanc: {}, liberadas: null }),
  false, 'nem a operação pendente ressuscita um repasse já pago');
assert.strictEqual(
  eh({ ...base, status: 1, cedente_id: 'x' }, { opsByLanc: {}, cedMap: {}, credorPorLanc: {}, liberadas: null }),
  false, 'nem o cedente_id');

// O corte tem de ser a primeira linha, antes de qualquer origem.
const fonte = corta('function _finLancEhRepasse(l, ctx){', '\n}');
const i = fonte.indexOf('_finLancQuitado(l)');
assert.ok(i >= 0, 'a quitação precisa estar explícita na função');
assert.ok(i < fonte.indexOf('ctx.opsByLanc') && i < fonte.indexOf('ctx.liberadas'),
  'o corte precisa preceder as origens');

console.log('F-23 ok — repasse pago não acende, por origem nenhuma.');
