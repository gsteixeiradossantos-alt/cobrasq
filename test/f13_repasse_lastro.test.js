/*
 * Teste F-13 — o "↗ a repassar" só acende com o dinheiro em caixa.
 *
 * Em 31/08/2026 a aba Movimentações acendia o marcador de repasse em saída que ainda
 * não era devida. O caso: Leonardo dos Santos Fortes, saída de R$ 500,00 ao Odontomundi
 * com vencimento em 10/10, com a receita que ela repassa — a parcela 15/15, mesmo
 * 10/10 — ainda em aberto. Não havia o que repassar. Eram 323 saídas futuras,
 * R$ 141.657,43, todas acesas: o chip "A repassar" contava dinheiro fora do caixa.
 *
 * A cura é vínculo GRAVADO (`fin_lancamento.repassa_lancamento_id`), não inferência por
 * data — devedor que atrasa faria a seta acender com o caixa vazio.
 *
 * O que este teste tranca é a assimetria dos dois erros. Deixar de acender um repasse
 * devido esconde dinheiro do credor; acender um indevido só antecipa uma linha. Por isso
 * "não sei" (coluna ausente, vínculo NULL, receita fora do alcance) tem de manter o
 * comportamento antigo — nunca virar "sem lastro".
 *
 * Como rodar:
 *   node test/f13_repasse_lastro.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// A função é curta e sem template literal — recorte simples até o `\n}` que a fecha.
function recorta(marca) {
  const i = HTML.indexOf(marca);
  assert.ok(i >= 0, `não achei no index.html: ${marca}`);
  const j = HTML.indexOf('\n}', i);
  assert.ok(j > i, `não achei o fim de ${marca}`);
  return HTML.slice(i, j + 2);
}

const ctxVm = { };
vm.createContext(ctxVm);
vm.runInContext(
  recorta('function _finLancEhRepasse(l, ctx){') + '\nthis._finLancEhRepasse = _finLancEhRepasse;',
  ctxVm
);
const ehRepasse = ctxVm._finLancEhRepasse;

// ── Cenário real: o caso Leonardo ───────────────────────────────────────────────────
// A saída aponta para a receita 124040 (parcela 15/15). `credorPorLanc` preenchido é o
// que fazia a seta acender antes — sem ele o teste passaria por acidente.
const SAIDA = { id: 124879, tipo_movimento: 0, repassa_lancamento_id: 124040 };
const base = { opsByLanc: {}, credorPorLanc: { 124879: 'Clínica Odontológica Balvedi Ltda Odontomundi' } };

// 1) Receita ainda em aberto → não há o que repassar.
assert.strictEqual(
  ehRepasse(SAIDA, Object.assign({}, base, { lastro: { 124040: false } })),
  false,
  'saída cuja receita não entrou NÃO pode contar como "a repassar"'
);

// 2) Receita recebida → volta a acender. É o dia em que o repasse vira devido.
assert.strictEqual(
  ehRepasse(SAIDA, Object.assign({}, base, { lastro: { 124040: true } })),
  true,
  'recebida a parcela, o repasse é devido e tem de acender'
);

// ── Os três "não sei" — todos mantêm o comportamento antigo ────────────────────────
// 3) Coluna ainda não aplicada em produção: o lançamento chega sem o campo.
assert.strictEqual(
  ehRepasse({ id: 124879, tipo_movimento: 0 }, Object.assign({}, base, { lastro: {} })),
  true,
  'sem a coluna, a tela não pode regredir: mantém o comportamento anterior'
);

// 4) Vínculo NULL (as 141 saídas sem par, e as 3 ambíguas que ficaram de fora).
assert.strictEqual(
  ehRepasse({ id: 124879, tipo_movimento: 0, repassa_lancamento_id: null },
            Object.assign({}, base, { lastro: { 124040: false } })),
  true,
  'vínculo desconhecido não é "sem lastro"'
);

// 5) Receita apontada fora do alcance da consulta (apagada, por exemplo): o mapa não
//    tem a chave. `undefined` não é `false` — e a diferença é dinheiro do credor.
assert.strictEqual(
  ehRepasse(SAIDA, Object.assign({}, base, { lastro: { 999999: true } })),
  true,
  'receita ausente do mapa não pode ser lida como não recebida'
);

// 6) E o ctx sem `lastro` nenhum (qualquer chamador antigo) não pode explodir.
assert.strictEqual(ehRepasse(SAIDA, base), true, 'ctx sem lastro segue o caminho antigo');

// ── A regra antiga continua valendo para o resto ────────────────────────────────────
// 7) Operação de repasse pendente segue mandando, mesmo com lastro presente.
assert.strictEqual(
  ehRepasse({ id: 7, tipo_movimento: 0 },
            { opsByLanc: { 7: { repasse_status: 'pendente' } }, credorPorLanc: {}, lastro: {} }),
  true,
  'operação pendente continua sendo "a repassar"'
);
// 8) Operação já efetuada não é mais "a repassar".
assert.strictEqual(
  ehRepasse({ id: 8, tipo_movimento: 0 },
            { opsByLanc: { 8: { repasse_status: 'efetuado' } }, credorPorLanc: {}, lastro: {} }),
  false,
  'operação efetuada não conta'
);

// ── O portão precisa vir ANTES das três origens, senão não filtra nada ─────────────
const fonte = recorta('function _finLancEhRepasse(l, ctx){');
assert.ok(
  fonte.indexOf('ctx.lastro') < fonte.indexOf('ctx.opsByLanc'),
  'a checagem de lastro tem de preceder as origens, senão a operação decide antes'
);

console.log('F-13 ok — o ↗ só acende com o dinheiro em caixa, e "não sei" não vira "sem lastro".');
