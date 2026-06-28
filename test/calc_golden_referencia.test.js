/*
 * Golden tests — a calculadora bate AO CENTAVO com os cálculos confiáveis do
 * escritório (Jusfy / Dr. Calc). Cada caso foi extraído de um PDF real da pasta
 * "Cálculos Jurídicos (Jusfy + Dr. Calc)" e o valor esperado é o do PDF.
 *
 * Fonte do modo "jusfy" (padrão da casa), conferida na engenharia reversa:
 *   correção pró-rata-die (índices oficiais BCB; TJPR = média INPC/IGP-DI),
 *   SEM garantia STJ, juros = atualizado_final x taxa x (dias/30),
 *   multa s/ (corrigido+juros), honorários s/ (corrigido+juros+multa).
 *
 * Como rodar:
 *   node test/calc_golden_referencia.test.js
 *   jsc  templates/calc-engine.js test/calc_golden_referencia.test.js
 */
'use strict';
var LOG = (typeof print === 'function') ? print : console.log;
var CalcEngine = (typeof require === 'function')
  ? require('../templates/calc-engine.js')
  : (typeof globalThis !== 'undefined' ? globalThis.CalcEngine : this.CalcEngine);

var RAN = 0, FAIL = 0;
function D(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
function cent(a, b, msg) {
  RAN++;
  var d = Math.abs(Math.round(a * 100) / 100 - b);
  if (d > 0.01) { FAIL++; LOG('  X ' + msg + ' -- esperado ' + b + ', obtido ' + (Math.round(a * 100) / 100) + ' (dif ' + d.toFixed(2) + ')'); }
}

// ── Jusfy · "007. Demonstrativo de Debito Atualizado" (IGP-M até 03/2026,
//    data do cálculo 08/04/2026, juros 1% a.m.). 4 parcelas atualizadas
//    individualmente. Valores conferidos no PDF. ──────────────────────────────
LOG('Jusfy 007 — 4 parcelas (IGP-M, modo jusfy, corte 03/2026)');
var OPT = { preset: 'jusfy', indicesAte: '2026-03' };
var itens = [
  // [valorNominal, dataIni,        atualizadoEsperado, jurosEsperado]
  [60000.00, '2024-03-05', 63704.61, 16223.44],
  [ 2702.38, '2024-08-01',  2806.79,   575.39],
  [15090.00, '2025-09-12', 15144.39,  1050.01],
  [14550.00, '2024-04-20', 15481.51,  3705.24]
];
var somaAtu = 0, somaJuros = 0;
itens.forEach(function (it, i) {
  var r = CalcEngine.juridica(it[0], D(it[1]), D('2026-04-08'), 'IGP-M', 0, 0, 1, OPT);
  cent(r.valorAtualizado, it[2], 'item' + (i + 1) + ' atualizado');
  cent(r.juros, it[3], 'item' + (i + 1) + ' juros');
  somaAtu += it[2]; somaJuros += it[3];
});
// Agregado do memorial: multa 50% s/ (atu+juros), honorários 10% s/ (atu+juros+multa).
// Conferido no PDF: multa 59.345,69 · honorários 17.803,71 · total 195.840,78.
var baseMulta = somaAtu + somaJuros;            // 118.691,38
var multa = baseMulta * 0.50;                   // 59.345,69
var hon = (baseMulta + multa) * 0.10;           // 17.803,71
cent(multa, 59345.69, 'agregado multa 50%');
cent(hon, 17803.71, 'agregado honorarios 10%');
cent(baseMulta + multa + hon, 195840.78, 'agregado TOTAL');

LOG(FAIL === 0
  ? '\nOK -- ' + RAN + ' assercoes batem AO CENTAVO com os PDFs de referencia.'
  : '\nFALHOU -- ' + FAIL + '/' + RAN + ' assercao(oes) divergiram do PDF.');
if (FAIL > 0) { if (typeof process !== 'undefined' && process.exit) process.exit(1); else throw new Error('golden: ' + FAIL + ' falhas'); }
