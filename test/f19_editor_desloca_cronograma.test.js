/*
 * Teste F-19 — "Todas as parcelas" também vale para a DATA.
 *
 * O editor de lançamento oferece três escopos: "Somente esta parcela", "Esta e as
 * próximas" e "Todas as parcelas do acordo". Até 31/08/2026 os dois últimos propagavam
 * valor, tipo, conta e contato — mas a DATA ficava só na parcela editada.
 *
 * O caso: Marilete Lazarotto, cronograma de repasse de 5 parcelas. O Gustavo mudou a 1/5
 * de 10/09/2026 para 10/01/2027, escolheu o escopo da série e salvou. As outras quatro
 * continuaram em out/nov/dez — e a 5/5 passou a colidir com a 1/5 no mesmo 10/01, com a
 * série fora de ordem.
 *
 * O que este teste tranca é a forma do conserto. Carimbar a data nova em todas empilharia
 * o acordo inteiro num dia só — pior que o defeito. O que se propaga é o SALTO, e em
 * MESES: de 10/09/2026 para 10/01/2027 são 122 dias, e somar 122 dias à parcela seguinte
 * (10/10) daria 09/02 — o dia 10 do vencimento se perderia, e num acordo de 28 parcelas
 * o erro se acumula.
 *
 * Como rodar:
 *   node test/f19_editor_desloca_cronograma.test.js
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

const ctx = { Date, Math, String, Number, isoLocal: (d) => d.toISOString().slice(0, 10) };
vm.createContext(ctx);
vm.runInContext(
  corta('function _finEdSaltoDatas(de, para){', '\n}') + '\n'
  + corta('function _finEdAplicaSalto(data, salto){', '\n}') + '\n'
  + 'this._salto = _finEdSaltoDatas; this._aplica = _finEdAplicaSalto;',
  ctx
);
const aplica = ctx._aplica;
// `_finEdSaltoDatas` devolve um objeto criado DENTRO do sandbox: outro protótipo, então
// deepStrictEqual reprova por identidade de classe, não por valor. Comparar o conteúdo.
const salto = ctx._salto;
const saltoJson = (a, b) => JSON.stringify(salto(a, b));

// ── O caso Marilete, ponta a ponta ─────────────────────────────────────────────────
const s = salto('2026-09-10', '2027-01-10');
assert.strictEqual(saltoJson('2026-09-10', '2027-01-10'), '{"meses":4}',
  'mesmo dia do mês ⇒ salto em MESES, não em dias');

// As outras quatro parcelas, com o espaçamento preservado.
assert.strictEqual(aplica('2026-10-10', s), '2027-02-10');
assert.strictEqual(aplica('2026-11-10', s), '2027-03-10');
assert.strictEqual(aplica('2026-12-10', s), '2027-04-10');
assert.strictEqual(aplica('2027-01-10', s), '2027-05-10');
// Nenhuma colidiu, e a ordem foi mantida — que era o defeito.
const depois = ['2026-10-10','2026-11-10','2026-12-10','2027-01-10'].map(d => aplica(d, s));
assert.strictEqual(new Set(depois).size, depois.length, 'parcelas não podem cair no mesmo dia');
assert.deepStrictEqual(depois.slice().sort(), depois, 'a ordem da série tem de se manter');

// ── Virada de ano nos dois sentidos ────────────────────────────────────────────────
assert.strictEqual(aplica('2026-11-10', { meses: 3 }), '2027-02-10');
assert.strictEqual(aplica('2027-02-10', { meses: -3 }), '2026-11-10', 'antecipar também tem de funcionar');
assert.strictEqual(saltoJson('2027-01-10', '2026-11-10'), '{"meses":-2}');

// ── Dia que não existe no mês de destino ───────────────────────────────────────────
// 31 de janeiro + 1 mês não é 3 de março: cai no último dia de fevereiro, que é o que
// qualquer agenda de cobrança faz.
assert.strictEqual(aplica('2027-01-31', { meses: 1 }), '2027-02-28');
assert.strictEqual(aplica('2028-01-31', { meses: 1 }), '2028-02-29', 'ano bissexto');

// ── Salto que não é de meses inteiros cai em dias ──────────────────────────────────
const d = salto('2026-09-10', '2026-09-25');
assert.strictEqual(saltoJson('2026-09-10', '2026-09-25'), '{"dias":15}',
  'dia do mês diferente ⇒ salto em dias');
assert.strictEqual(aplica('2026-10-10', d), '2026-10-25');

// ── Sem mudança, sem deslocamento ──────────────────────────────────────────────────
assert.strictEqual(salto('2026-09-10', '2026-09-10'), null, 'data igual não desloca nada');
assert.strictEqual(salto('', '2027-01-10'), null, 'parcela sem vencimento não gera salto');
assert.strictEqual(salto('2026-09-10', ''), null);
assert.strictEqual(aplica('2026-10-10', null), '2026-10-10', 'sem salto, a data não muda');

// ── O salvamento aplica isso à série, e não à data de pagamento ────────────────────
const bloco = corta('// ── O cronograma anda junto', 'if(salto){');
assert.ok(bloco.includes('_finEdSaltoDatas(l.data_vencimento'),
  'o salto tem de sair da parcela editada, comparando o vencimento antigo com o novo');
const corpo = corta('const salto = _finEdSaltoDatas', '\n      }');
assert.ok(!/data_pagamento/.test(corpo),
  'a data de PAGAMENTO nunca se desloca — é fato consumado, não agenda');
assert.ok(/if\(!item \|\| !item\.data_vencimento\) continue;/.test(corpo),
  'parcela sem vencimento fica intocada');

console.log('F-19 ok — o escopo da série desloca o cronograma, preservando o espaçamento.');
