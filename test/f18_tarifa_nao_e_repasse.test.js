/*
 * Teste F-18 — tarifa do Asaas não é repasse ao cedente.
 *
 * Em 31/08/2026, ao migrar a Rita Bet para o CRM, os 16 lançamentos soltos dela foram
 * amarrados à cobrança nova. A tarifa de boleto de R$ 1,99 passou a resolver credor pela
 * cobrança e, com isso, a se anunciar como "↗ a repassar" com a sublinha "repasse a
 * Injetcar" — um pagamento ao cedente que não existe.
 *
 * A causa é uma exclusão que existia em dois dos três lugares. `_finRepasseLiberado()`
 * exclui tarifa na própria consulta (`not.ilike %tarifa%`) e o portão do lastro também,
 * mas a TERCEIRA origem de `_finLancEhRepasse` — "está no mapa de credor" — não excluía.
 * Enquanto a tarifa não tinha cobrança, o defeito ficou invisível.
 *
 * O vínculo da tarifa com o caso está CERTO e não é o que se conserta aqui: a tarifa é
 * daquele caso, e é assim que ela aparece na conferência. O que muda é o significado
 * atribuído a ela.
 *
 * Como rodar:
 *   node test/f18_tarifa_nao_e_repasse.test.js
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
  + 'this._ehRepasse = _finLancEhRepasse; this._apuravel = _finRepasseTemLastroApuravel;'
  + 'this._tarifa = _finEhTarifa;',
  ctx
);
const ehRepasse = ctx._ehRepasse, apuravel = ctx._apuravel, ehTarifa = ctx._tarifa;

// As duas linhas reais da Rita Bet, ambas saídas com o MESMO credor pela mesma cobrança.
const TARIFA = { id: 125314, tipo_movimento: 0, status: 1, credor_id: 'injetcar',
                 descricao: 'Tarifa Asaas (boleto) — Rita Bet' };
const REPASSE = { id: 124873, tipo_movimento: 0, status: 0, credor_id: 'injetcar',
                  descricao: 'Rita Bet 1/7' };
const tela = (l) => ({ opsByLanc: {}, cedMap: {}, liberadas: null,
                       credorPorLanc: { [l.id]: 'Injetcar Mecânica e Auto Peças' } });

// ── O defeito ──────────────────────────────────────────────────────────────────────
assert.strictEqual(ehRepasse(TARIFA, tela(TARIFA)), false,
  'tarifa do Asaas NÃO é dinheiro a repassar ao cedente');

// E o controle, que prova que o fixture não é frouxo: a saída de repasse do MESMO caso,
// pelo MESMO caminho, continua acendendo.
assert.strictEqual(ehRepasse(REPASSE, tela(REPASSE)), true,
  'a saída de repasse continua contando pelo mapa de credor');

// ── A exclusão vale nas três leituras ──────────────────────────────────────────────
assert.strictEqual(apuravel(TARIFA), false, 'tarifa fora do universo do lastro');
assert.strictEqual(apuravel({ ...REPASSE }), true, 'repasse em aberto continua apurável');

// Maiúscula/minúscula e a marca do pente-fino não podem furar a exclusão.
assert.strictEqual(ehTarifa({ descricao: 'TARIFA Asaas (Pix) — Fulano · verificar' }), true);
assert.strictEqual(ehTarifa({ descricao: 'Tarifa Asaas (boleto) — Rita Bet' }), true);
assert.strictEqual(ehTarifa({ descricao: 'Rita Bet 1/7' }), false);
assert.strictEqual(ehTarifa({}), false, 'linha sem descrição não pode explodir');

// ── A consulta de _finRepasseLiberado continua excluindo tarifa ────────────────────
// Se alguém tirar o filtro de lá, a tarifa volta a disputar entrada com repasse de
// verdade — e a exclusão local aqui não salvaria o pareamento.
assert.ok(/not\('descricao'\s*,\s*'ilike'\s*,\s*'%tarifa%'\)/.test(HTML),
  'a consulta de _finRepasseLiberado tem de continuar excluindo tarifa');

// ── A sublinha da tarifa não pode dizer "repasse a" ────────────────────────────────
const linha = corta('const sub = cedente', ';');
assert.ok(linha.includes('_finEhTarifa(l)'),
  'a sublinha precisa tratar tarifa como "carteira de", não "repasse a"');

console.log('F-18 ok — tarifa é do caso, não é repasse ao cedente.');
