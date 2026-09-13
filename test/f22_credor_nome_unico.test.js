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
 * do CRM. Agora todas as leituras passam pelo mesmo helper.
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

// ── TODAS as leituras usam o mesmo helper ──────────────────────────────────────────
// É o ponto do conserto: uma delas divergindo recria o defeito. Eram três leituras de
// `clientes`; desde o PR de Movimentações (13/09/2026) são duas — a dos credores das
// operações e a das linhas sem operação viraram uma ida só. O que importa: TODA leitura
// de `clientes` na aba pede exatamente id,nome,nome_fantasia, passa pelo helper, e
// ninguém monta o nome à mão. Comentários não contam.
const carregar = corta('async function _finLancCascataCarregar(){', '\n}');
const corpo = carregar.replace(/\/\/.*$/gm, '');
const leituras = (corpo.match(/\.from\('clientes'\)/g) || []).length;
const certas   = (corpo.match(/\.from\('clientes'\)\.select\('id,nome,nome_fantasia'\)/g) || []).length;
const usos     = (corpo.match(/_finNomeCredor\(/g) || []).length;
assert.ok(leituras >= 2, `esperava ao menos duas leituras de clientes na aba (achei ${leituras})`);
assert.strictEqual(certas, leituras, `toda leitura de clientes pede exatamente id,nome,nome_fantasia (${certas} de ${leituras})`);
assert.strictEqual(usos, leituras, `toda leitura de credor passa pelo helper (leituras ${leituras}, usos ${usos})`);
assert.ok(!/\.nome\b|\.nome_fantasia\b/.test(corpo), 'ninguém monta o nome à mão na aba — só _finNomeCredor lê nome/nome_fantasia');

// E nenhuma delas pode voltar a ler só `nome`.
assert.ok(!/from\('clientes'\)\.select\('id,nome'\)/.test(carregar),
  'nenhuma consulta de credor pode pedir só `nome` — sem fantasia o critério se perde');

// ── A sublinha continua saindo de uma função só ────────────────────────────────────
assert.ok(HTML.includes('function _finLancCedente(l, ctx){'),
  '_finLancCedente continua sendo a fonte única do nome exibido');

console.log('F-22 ok — nome do credor é o fantasia, por todas as leituras da aba.');
