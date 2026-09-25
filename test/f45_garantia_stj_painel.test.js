/*
 * Teste F-45 — garantia STJ na calcDividaAtualizada (index.html, conta da execução).
 *
 * A garantia travava o fator ACUMULADO em 1 a cada mês de INPC negativo, e os meses
 * positivos seguintes compunham a partir do piso, inflando a correção. O piso vale só
 * para o fator exibido: saldo = nominal × max(fator acumulado real, 1). Os juros de cada
 * mês incidem sobre o saldo com piso (decisão de 25/09/2026). Mesma regra do motor
 * canônico templates/calc-engine.js (PR #808).
 *
 * Como rodar:
 *   node test/f45_garantia_stj_painel.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function trecho(inicio) {
  const ini = HTML.indexOf(inicio);
  assert.ok(ini >= 0, inicio + ' não existe mais no index.html');
  return HTML.slice(ini, HTML.indexOf('\n}', ini) + 2);
}
const iniTab = HTML.indexOf('const CALC_INPC_MENSAL = {');
assert.ok(iniTab >= 0, 'CALC_INPC_MENSAL não existe mais no index.html');
const tabela = HTML.slice(iniTab, HTML.indexOf('};', iniTab) + 2).replace('const ', 'var ');

// "hoje" fixo em 31/12/2022: a função lê new Date() sem argumento.
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(2022, 11, 31, 12, 0, 0); else super(...a); }
}
const ctx = { Math, String, Number, Date: FakeDate, DB: { config: { calcParams: { jurosMensal: 0.01, multa: 0 } } } };
vm.createContext(ctx);
vm.runInContext([tabela, trecho('function getCalcParams(){'), trecho('function _calcSegmentosMes('),
  trecho('function calcDividaAtualizada(')].join('\n'), ctx);

let falhas = 0;
function ok(nome, cond, detalhe) {
  if (cond) { console.log(`  ok  ${nome}`); return; }
  falhas++; console.log(`  FALHOU  ${nome}${detalhe ? ' — ' + detalhe : ''}`);
}
const perto = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-9);

console.log('F-45 · garantia STJ na calcDividaAtualizada (index.html)\n');

// INPC jul/22 -0,60, ago/22 -0,31, set/22 -0,32, out 0,47, nov 0,38, dez 0,69.
const T = vm.runInContext('CALC_INPC_MENSAL', ctx);
const meses = ['2022-07', '2022-08', '2022-09', '2022-10', '2022-11', '2022-12'];
let f = 1; meses.forEach(m => { f *= 1 + T[m] / 100; });
const r = ctx.calcDividaAtualizada(1000, '2022-07-01');
ok('atualizado = nominal × fator acumulado real', perto(r.atualizado, 1000 * Math.max(f, 1)),
  `atualizado=${r.atualizado.toFixed(4)} esperado=${(1000 * Math.max(f, 1)).toFixed(4)}`);
ok('não compõe a partir do piso (bug: ~1015,50)', r.atualizado < 1005, `atualizado=${r.atualizado.toFixed(2)}`);

// Juros sobre o saldo com piso: jul–set segurados em 1000.
let saldo = 1000, fa = 1, juros = 0;
[31, 31, 30, 31, 30, 31].forEach((dias, i) => {
  const ef0 = Math.max(fa, 1); fa *= 1 + T[meses[i]] / 100;
  saldo *= Math.max(fa, 1) / ef0; juros += saldo * 0.01 * (dias / 30);
});
ok('juros incidem sobre o saldo com piso', perto(r.juros, juros), `juros=${r.juros.toFixed(4)} esperado=${juros.toFixed(4)}`);

ok('nunca abaixo do nominal', r.atualizado >= 1000 - 1e-9);

console.log(falhas === 0 ? '\nOK' : `\n${falhas} falha(s)`);
process.exit(falhas === 0 ? 0 : 1);
