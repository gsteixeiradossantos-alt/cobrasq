/*
 * Teste F-22 — a mesma empresa não pode ter dois nomes na mesma lista.
 *
 * A sublinha de Movimentações ("carteira de X" / "repasse a X") buscava o nome do credor
 * em dois lugares com critérios diferentes:
 *
 *   • pela fin_operacao      → clientes.nome            (RAZÃO SOCIAL)
 *   • pela cobrança          → nome_fantasia || nome    (FANTASIA)
 *
 * Resultado, medido em 31/08/2026: a Saine Americo Ribeiro parecia ter dois credores —
 * "Cecato Clinica Veterinaria Ltda" no repasse vindo da operação e "S.O.S Animal" nos
 * lançados à mão. É a MESMA empresa (razão social e fantasia). A Juliana Pinto Ribeiro
 * tinha o mesmo sintoma: "Arte Estofados Decor Ltda" na parcela 1/8 e "Arte Estofados -
 * Dois Vizinhos" nas outras sete.
 *
 * O critério certo é o FANTASIA — é o que a view `casos` usa para montar a coluna "credor"
 * do CRM. Agora as três leituras passam pelo mesmo helper.
 *
 * Como rodar:
 *   node test/f22_credor_nome_unico.test.js
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
vm.runInContext(corta('const _finNomeCredor', '\n') + 'this._nome = _finNomeCredor;', ctx);
const nome = ctx._nome;

// ── O critério ─────────────────────────────────────────────────────────────────────
const CECATO = { id: 'c', nome: 'Cecato Clinica Veterinaria Ltda', nome_fantasia: 'S.O.S Animal' };
assert.strictEqual(nome(CECATO), 'S.O.S Animal', 'com fantasia, mostra a fantasia');

assert.strictEqual(nome({ nome: 'Injetcar Mecânica e Auto Peças', nome_fantasia: null }),
  'Injetcar Mecânica e Auto Peças', 'sem fantasia, cai na razão social');
assert.strictEqual(nome({ nome: 'Fulano Ltda', nome_fantasia: '' }), 'Fulano Ltda',
  'fantasia vazia não pode virar nome em branco na tela');
assert.strictEqual(nome(null), null, 'cliente ausente não explode');
assert.strictEqual(nome(undefined), null);
assert.strictEqual(nome({}), null, 'cliente sem nenhum nome devolve null, não "undefined"');

// ── As TRÊS leituras usam o mesmo helper ───────────────────────────────────────────
// É o ponto do conserto: uma delas divergindo recria o defeito.
const carregar = corta('async function _finLancCascataCarregar(){', '\n}');
const usos = (carregar.match(/_finNomeCredor\(/g) || []).length;
assert.strictEqual(usos, 3, `as três leituras de credor têm de passar pelo helper (achei ${usos})`);

// E nenhuma delas pode voltar a ler só `nome`.
assert.ok(!/from\('clientes'\)\.select\('id,nome'\)/.test(carregar),
  'nenhuma consulta de credor pode pedir só `nome` — sem fantasia o critério se perde');

// ── A sublinha continua saindo de uma função só ────────────────────────────────────
assert.ok(HTML.includes('function _finLancCedente(l, ctx){'),
  '_finLancCedente continua sendo a fonte única do nome exibido');

console.log('F-22 ok — nome do credor é o fantasia, pelas três leituras.');
