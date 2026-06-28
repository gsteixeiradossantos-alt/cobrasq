/*
 * Teste da MATRIZ de cálculo (calc-engine.js) — CONTRATO do motor v2.
 *
 * Mudança importante (2026-06): a conta jurídica passou a reproduzir os cálculos
 * confiáveis do escritório (Jusfy/Dr. Calc), com correção PRÓ-RATA, índices
 * oficiais do BCB (TJPR = média INPC/IGP-DI) e PRESETS de metodologia. Os valores
 * ABSOLUTOS conferidos contra PDFs reais ficam em `calc_golden_referencia.test.js`.
 * AQUI travamos: (1) as tabelas oficiais; (2) o CONTRATO de cada preset (sobre o
 * que multa/honorários/juros incidem); (3) a cobrança (núcleo inalterado).
 *
 * Como rodar:
 *   node test/calc_engine.test.js
 *   jsc  templates/calc-engine.js test/calc_engine.test.js
 */
'use strict';

var LOG = (typeof print === 'function') ? print : console.log;
var CalcEngine = (typeof require === 'function')
  ? require('../templates/calc-engine.js')
  : (typeof globalThis !== 'undefined' ? globalThis.CalcEngine : this.CalcEngine);

var RAN = 0, FAIL = 0;
function ok(cond, msg) { RAN++; if (!cond) { FAIL++; LOG('  X ' + msg); } }
function near(a, b, msg, eps) {
  RAN++;
  var d = Math.abs(a - b);
  if (!(d <= (eps || 1e-9))) { FAIL++; LOG('  X ' + msg + ' -- d=' + d + ' (a=' + a + ', b=' + b + ')'); }
}
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function D(y, m, d) { return new Date(y, m, d); }

// ───────────────────────────── 1) Tabelas oficiais ─────────────────────────
LOG('1) Tabelas oficiais BCB + TJPR = media(INPC, IGP-DI)');
(function () {
  var T = CalcEngine.TABELAS;
  // âncoras de valores oficiais (BCB/SGS) conferidas à mão
  near(T.INPC['2024-08'], -0.14, 'INPC 2024-08');
  near(T['IGP-M']['2024-10'], 1.52, 'IGP-M 2024-10');
  near(T['IGP-DI']['2026-04'], 2.41, 'IGP-DI 2026-04');
  near(T.SELIC['2025-01'], 1.01, 'SELIC 2025-01');
  // TJPR é a média aritmética mensal de INPC e IGP-DI (Tabela Pratica TJPR)
  ['2025-06', '2026-02', '2026-04'].forEach(function (m) {
    near(T.TJPR[m], (T.INPC[m] + T['IGP-DI'][m]) / 2, 'TJPR ' + m + ' == media(INPC,IGP-DI)');
  });
  // cobertura histórica (não mais 26 meses)
  ok(('2000-01' in T.INPC), 'INPC cobre desde 2000-01');
  ok(Object.keys(T.INPC).length >= 300, 'INPC tem 300+ meses (=' + Object.keys(T.INPC).length + ')');
  ok(CalcEngine.INDICES_ATE === '2026-05', 'INDICES_ATE == 2026-05 (=' + CalcEngine.INDICES_ATE + ')');
})();

// ───────────────────── 2) Contrato dos PRESETS (jurídica) ───────────────────
LOG('2) Contrato dos presets jusfy/drcalc');
(function () {
  // preset jusfy: multa s/ (atu+juros); honorarios s/ (atu+juros+multa); sem garantia
  var j = CalcEngine.juridica(10000, D(2022, 0, 10), D(2025, 5, 15), 'INPC', 10, 20, 1, { preset: 'jusfy' });
  near(j.multa, (j.valorAtualizado + j.juros) * 0.10, 'jusfy: multa s/ (atu+juros)');
  near(j.honorarios, (j.valorAtualizado + j.juros + j.multa) * 0.20, 'jusfy: hon s/ (atu+juros+multa)');
  near(j.juros, j.valorAtualizado * 0.01 * (Math.round((D(2025, 5, 15) - D(2022, 0, 10)) / 86400000) / 30), 'jusfy: juros = atu x 1% x dias/30');
  ok(j.garantiaSTJ === false, 'jusfy: garantia STJ desligada');

  // preset drcalc: multa s/ corrigido (sem juros); honorarios s/ (atu+juros) SEM multa; juros por meses inteiros
  var d = CalcEngine.juridica(10000, D(2022, 0, 10), D(2025, 5, 15), 'INPC', 10, 20, 1, { preset: 'drcalc' });
  near(d.multa, d.valorAtualizado * 0.10, 'drcalc: multa s/ corrigido');
  near(d.honorarios, (d.valorAtualizado + d.juros) * 0.20, 'drcalc: hon s/ (atu+juros), SEM multa');
  // meses inteiros entre 10/01/2022 e 15/06/2025 = 41
  near(d.juros, d.valorAtualizado * 0.01 * 41, 'drcalc: juros por meses inteiros (41)');

  // override avulso de base (configurável por caso) sobrepõe o preset
  var x = CalcEngine.juridica(10000, D(2024, 0, 1), D(2025, 0, 1), 'TJPR', 10, 10, 1, { preset: 'jusfy', multaBase: 'corrigido', honBase: 'sem_multa' });
  near(x.multa, x.valorAtualizado * 0.10, 'override multaBase=corrigido');
  near(x.honorarios, (x.valorAtualizado + x.juros) * 0.10, 'override honBase=sem_multa');
})();

// ─────────────────── 3) Garantia STJ (opcional) + cutoff + SELIC ────────────
LOG('3) Garantia STJ opcional, cutoff e SELIC');
(function () {
  // serie TJPR jun/2025 deflacionaria: sem garantia pode cair; com garantia trava >= nominal
  var semG = CalcEngine.juridica(1000, D(2025, 4, 1), D(2025, 6, 15), 'TJPR', 0, 0, 0, { preset: 'jusfy' });
  ok(semG.valorAtualizado < 1000, 'sem garantia: deflacao reduz o atualizado (=' + semG.valorAtualizado.toFixed(2) + ')');
  var comG = CalcEngine.juridica(1000, D(2025, 4, 1), D(2025, 6, 15), 'TJPR', 0, 0, 0, { preset: 'jusfy', garantiaSTJ: true });
  ok(comG.valorAtualizado >= 999.9999, 'com garantia: atualizado nunca < nominal (=' + comG.valorAtualizado.toFixed(2) + ')');

  // cutoff: índice de mês posterior a indicesAte nao corrige
  var capA = CalcEngine.juridica(1000, D(2024, 0, 1), D(2025, 0, 1), 'INPC', 0, 0, 0, { preset: 'jusfy', indicesAte: '2024-06' });
  var capB = CalcEngine.juridica(1000, D(2024, 0, 1), D(2025, 0, 1), 'INPC', 0, 0, 0, { preset: 'jusfy', indicesAte: '2026-05' });
  ok(capA.valorAtualizado < capB.valorAtualizado, 'cutoff antigo corrige menos meses');

  // SELIC embute juros: sem 1% a.m. separado
  var s = CalcEngine.juridica(1000, D(2024, 0, 1), D(2025, 0, 1), 'SELIC', 0, 0, 1, { preset: 'jusfy' });
  ok(s.juros === 0, 'SELIC: juros separados = 0 (embutidos na correcao)');
})();

// ─────────────────── 4) Cobrança: fuzz 200 casos == oráculo ─────────────────
// (núcleo da cobrança extrajudicial NÃO mudou — segue reproduzindo a fórmula original)
LOG('4) Cobranca: 200 casos aleatorios -- motor == formula original');
function legCobranca(valorOriginal, meses, corrM, jurosM, multaP, taxaS, aplicarMulta, aplicarTaxa) {
  var correcao = valorOriginal * corrM * meses;
  var valorCorrigido = valorOriginal + correcao;
  var juros = valorCorrigido * jurosM * meses;
  var multa = aplicarMulta ? valorCorrigido * multaP : 0;
  var subtotal = valorCorrigido + juros + multa;
  var taxa = aplicarTaxa ? subtotal * taxaS : 0;
  var total = Math.ceil(subtotal + taxa);
  return { correcao: correcao, valorCorrigido: valorCorrigido, juros: juros, multa: multa, subtotal: subtotal, taxa: taxa, total: total };
}
(function () {
  var rnd = mulberry32(987654321);
  for (var i = 0; i < 200; i++) {
    var valor = Math.round((300 + rnd() * 50000) * 100) / 100;
    var meses = Math.round((rnd() * 60) * 1e6) / 1e6;
    var corrM = 0.08 / 12, jurosM = 0.01, multaP = 0.02, taxaS = 0.30;
    var aM = rnd() > 0.5, aT = rnd() > 0.5;
    var got = CalcEngine.cobranca({ valorOriginal: valor, meses: meses, correcaoMensal: corrM, jurosMensal: jurosM, multaPct: multaP, taxaServico: taxaS, aplicarMulta: aM, aplicarTaxa: aT });
    var exp = legCobranca(valor, meses, corrM, jurosM, multaP, taxaS, aM, aT);
    near(got.correcao, exp.correcao, 'cob#' + i + ' correcao');
    near(got.valorCorrigido, exp.valorCorrigido, 'cob#' + i + ' valorCorrigido');
    near(got.juros, exp.juros, 'cob#' + i + ' juros');
    near(got.multa, exp.multa, 'cob#' + i + ' multa');
    near(got.subtotal, exp.subtotal, 'cob#' + i + ' subtotal');
    near(got.taxa, exp.taxa, 'cob#' + i + ' taxa');
    ok(got.total === exp.total, 'cob#' + i + ' total (ceil) ' + got.total + ' == ' + exp.total);
  }
  // âncoras de cobrança
  var c = CalcEngine.cobranca({ valorOriginal: 1000, meses: 12, correcaoMensal: 0.08 / 12, jurosMensal: 0.01, multaPct: 0.02, taxaServico: 0.30, aplicarMulta: false, aplicarTaxa: false });
  ok(c.multa === 0, 'cobranca aplicarMulta=false -> multa 0');
  ok(c.taxa === 0, 'cobranca aplicarTaxa=false -> taxa 0');
  ok(c.total === Math.ceil(c.subtotal), 'cobranca total == ceil(subtotal) sem taxa');
})();

LOG(FAIL === 0
  ? '\nOK -- ' + RAN + ' assercoes passaram (contrato do motor v2 + cobranca).'
  : '\nFALHOU -- ' + FAIL + '/' + RAN + ' assercao(oes).');
if (FAIL > 0) { if (typeof process !== 'undefined' && process.exit) process.exit(1); else throw new Error('calc-engine: ' + FAIL + ' falhas'); }
