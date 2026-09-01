/*
 * Teste F-20 — receita nunca é "a repassar".
 *
 * A entrada 1/8 da Juliana Pinto Ribeiro (R$ 176,00, recebida em 06/08/2026) exibia o
 * marcador "↗ a repassar". `opsByLanc` indexa a MESMA fin_operacao pelos dois lados —
 * `lancamento_receita_id` e `lancamento_despesa_id` —, então a receita herdava o
 * `repasse_status = 'pendente'` que pertencia à despesa de R$ 89,25 do mesmo caso.
 * Três receitas em produção estavam assim.
 *
 * "A repassar" é afirmação sobre dinheiro que VAI SAIR. Receita é dinheiro que entrou —
 * a resposta certa é sempre não, por qualquer caminho. O corte por tipo subiu para o
 * topo da função, onde vale para as três origens, em vez de ficar repetido em uma só.
 *
 * É o terceiro caso da mesma família, e por isso o teste checa as três origens: tarifa
 * (#616), receita com carteira (#615) e agora receita com operação.
 *
 * Como rodar:
 *   node test/f20_receita_nao_e_repasse.test.js
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
  corta('const _finEhTarifa', '\n')
  + corta('function _finRepasseTemLastroApuravel(l){', '\n}')
  + corta('const _finLancQuitado', '\n')
  + corta('function _finLancEhRepasse(l, ctx){', '\n}')
  + 'this._eh = _finLancEhRepasse;',
  ctx
);
const eh = ctx._eh;

// ── O caso Juliana: uma operação, dois lançamentos ─────────────────────────────────
// A MESMA operação é indexada pela receita e pela despesa. Só a despesa pode acender.
const OP = { repasse_status: 'pendente' };
const RECEITA  = { id: 124304, tipo_movimento: 1, status: 1, descricao: 'Juliana Pinto Ribeiro (Arte Estofados) 1/8' };
const DESPESA  = { id: 124305, tipo_movimento: 0, status: 0, credor_id: 'arte',
                   descricao: 'Repasse ao credor — Arte Estofados 1/8' };
const tela = { opsByLanc: { 124304: OP, 124305: OP }, cedMap: {}, credorPorLanc: {}, liberadas: null };

assert.strictEqual(eh(RECEITA, tela), false, 'a receita NÃO herda o "a repassar" da despesa irmã');
assert.strictEqual(eh(DESPESA, tela), true,  'a despesa do mesmo caso continua acendendo');

// ── As outras duas origens também se calam para receita ────────────────────────────
// 2ª origem (cedente_id gravado no lançamento).
assert.strictEqual(eh({ id: 9, tipo_movimento: 1, cedente_id: 'x', descricao: 'entrada' },
  { opsByLanc: {}, cedMap: {}, credorPorLanc: {}, liberadas: null }), false,
  'receita com cedente_id não é repasse');
// 3ª origem (carteira resolvida pela cobrança) — o que o #615 já cobria.
assert.strictEqual(eh({ id: 10, tipo_movimento: 1, descricao: 'entrada' },
  { opsByLanc: {}, cedMap: {}, credorPorLanc: { 10: 'Arte Estofados' }, liberadas: null }), false,
  'receita com carteira conhecida não é repasse');

// ── E a tarifa (#616) continua fora, mesmo sendo saída ─────────────────────────────
assert.strictEqual(eh({ id: 11, tipo_movimento: 0, status: 1, credor_id: 'x',
  descricao: 'Tarifa Asaas (Pix) — Juliana Pinto Ribeiro (Arte Estofados)' },
  { opsByLanc: {}, cedMap: {}, credorPorLanc: { 11: 'Arte Estofados' }, liberadas: null }), false,
  'tarifa segue fora, como no #616');

// ── O corte tem de ser a PRIMEIRA linha, antes de qualquer origem ──────────────────
const fonte = corta('function _finLancEhRepasse(l, ctx){', '\n}');
const iTipo = fonte.indexOf('l.tipo_movimento !== 0');
assert.ok(iTipo >= 0, 'o corte por tipo tem de estar explícito na função');
assert.ok(iTipo < fonte.indexOf('ctx.liberadas') && iTipo < fonte.indexOf('ctx.opsByLanc'),
  'o corte precisa preceder as três origens, senão uma delas responde antes');

console.log('F-20 ok — receita nunca é "a repassar", por nenhuma das três origens.');
