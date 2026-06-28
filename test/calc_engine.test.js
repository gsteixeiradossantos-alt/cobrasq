/*
 * Teste da MATRIZ de cálculo (calc-engine.js).
 *
 * Objetivo nº 1: provar que centralizar NÃO MUDA NÚMERO. Para isso, o teste
 * carrega o motor real (calc-engine.js) e compara, em 200+ casos aleatórios
 * determinísticos, contra um ORÁCULO que reproduz a fórmula ORIGINAL verbatim
 * (a que estava inline em index.html/_petCalcJuridica e crm.html/_calc*). Se o
 * motor divergir do original em qualquer caso, o teste falha.
 *
 * Como rodar (qualquer um):
 *   node test/calc_engine.test.js                 (CI / Vercel)
 *   jsc  calc-engine.js test/calc_engine.test.js  (macOS JavaScriptCore)
 */
'use strict';

// ---- portabilidade node/jsc ------------------------------------------------
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

// PRNG determinístico (sem Date/Math.random p/ ser reprodutível).
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────── ORÁCULO (fórmula original verbatim) ──────────────
// Tabelas: superset transcrito de PECA_INDICES_MENSAIS (crm.html) — re-digitado
// SEPARADAMENTE do motor de propósito, para um erro de transcrição não passar
// igual nos dois lados.
var LEG = {
  INPC: {'2024-05':0.46,'2024-06':0.25,'2024-07':0.26,'2024-08':-0.14,'2024-09':0.48,'2024-10':0.61,'2024-11':0.33,'2024-12':0.48,'2025-01':0.00,'2025-02':1.48,'2025-03':0.51,'2025-04':0.48,'2025-05':0.35,'2025-06':0.23,'2025-07':0.21,'2025-08':-0.21,'2025-09':0.52,'2025-10':0.03,'2025-11':0.03,'2025-12':0.21,'2026-01':0.39,'2026-02':0.56,'2026-03':0.91,'2026-04':0.81},
  IPCA: {'2024-05':0.46,'2024-06':0.21,'2024-07':0.38,'2024-08':-0.02,'2024-09':0.44,'2024-10':0.56,'2024-11':0.39,'2024-12':0.52,'2025-01':0.16,'2025-02':1.31,'2025-03':0.56,'2025-04':0.43,'2025-05':0.26,'2025-06':0.24,'2025-07':0.26,'2025-08':-0.11,'2025-09':0.48,'2025-10':0.09,'2025-11':0.18,'2025-12':0.33,'2026-01':0.33,'2026-02':0.70,'2026-03':0.88,'2026-04':0.67},
  SELIC:{'2024-05':0.83,'2024-06':0.79,'2024-07':0.91,'2024-08':0.87,'2024-09':0.84,'2024-10':0.93,'2024-11':0.79,'2024-12':0.93,'2025-01':1.01,'2025-02':0.99,'2025-03':0.96,'2025-04':1.06,'2025-05':1.14,'2025-06':1.10,'2025-07':1.28,'2025-08':1.16,'2025-09':1.22,'2025-10':1.28,'2025-11':1.05,'2025-12':1.22,'2026-01':1.16,'2026-02':1.00,'2026-03':1.21,'2026-04':1.09,'2026-05':1.07,'2026-06':0.08},
  TJPR: {'2024-05':0.67,'2024-06':0.38,'2024-07':0.55,'2024-08':-0.01,'2024-09':0.76,'2024-10':1.07,'2024-11':0.76,'2024-12':0.68,'2025-01':0.06,'2025-02':1.24,'2025-03':0.01,'2025-04':0.39,'2025-05':-0.25,'2025-06':-0.79,'2025-07':0.07,'2025-08':-0.01,'2025-09':0.44,'2025-10':0.00,'2025-11':0.02,'2025-12':0.15,'2026-01':0.29,'2026-02':-0.14,'2026-03':1.02,'2026-04':1.61}
};
function legCorrecao(valorInicial, dataIni, dataFim, indice) {
  var tabela = LEG[indice] || LEG.INPC;
  var valor = valorInicial;
  var cursor = new Date(dataIni.getFullYear(), dataIni.getMonth(), dataIni.getDate());
  var mesesAplicados = 0;
  while (true) {
    var fimDoMes = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    if (fimDoMes >= dataFim) break;
    var chave = cursor.getFullYear() + '-' + String(cursor.getMonth() + 1).padStart(2, '0');
    var pct = (chave in tabela) ? tabela[chave] : 0;
    valor = valor * (1 + pct / 100);
    mesesAplicados++;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return { valorCorrigido: valor, mesesAplicados: mesesAplicados };
}
function legJuridica(valorNominal, dataIni, dataFim, indice, multaPct, honPct, jurosMensalPct) {
  var corr = legCorrecao(valorNominal, dataIni, dataFim, indice);
  var valorAtualizado = Math.max(corr.valorCorrigido, valorNominal);
  var dias = (dataFim - dataIni) / (1000 * 60 * 60 * 24);
  var mesesPRO = dias / 30;
  var juros = valorAtualizado * (jurosMensalPct / 100) * mesesPRO;
  var multa = valorAtualizado * (multaPct / 100);
  var honorarios = (valorAtualizado + juros + multa) * (honPct / 100);
  var total = valorAtualizado + juros + multa + honorarios;
  return { valorAtualizado: valorAtualizado, juros: juros, multa: multa, honorarios: honorarios, total: total, mesesCorrigidos: corr.mesesAplicados };
}
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

// ─────────────────────────────── 1) Tabelas ────────────────────────────────
LOG('1) Tabelas: motor == superset re-transcrito');
['INPC', 'IPCA', 'SELIC', 'TJPR'].forEach(function (ind) {
  var a = CalcEngine.TABELAS[ind], b = LEG[ind];
  ok(Object.keys(a).length === Object.keys(b).length, ind + ': no de meses igual (' + Object.keys(a).length + ' vs ' + Object.keys(b).length + ')');
  Object.keys(b).forEach(function (k) { ok(a[k] === b[k], ind + ' ' + k + ': ' + a[k] + ' == ' + b[k]); });
});
ok(CalcEngine.INDICES_ATE === '2026-06', 'INDICES_ATE == 2026-06');

// ──────────────────── 2) Jurídica: fuzz 200 casos == oráculo ────────────────
LOG('2) Juridica: 200 casos aleatorios -- motor == formula original');
(function () {
  var rnd = mulberry32(20260628);
  var indices = ['INPC', 'IPCA', 'SELIC', 'TJPR'];
  for (var i = 0; i < 200; i++) {
    var valor = Math.round((500 + rnd() * 90000) * 100) / 100;
    var ini = new Date(2024, 4, 1 + Math.floor(rnd() * 700));
    var fim = new Date(ini.getTime() + (10 + Math.floor(rnd() * 720)) * 86400000);
    var indice = indices[Math.floor(rnd() * indices.length)];
    var multaP = Math.floor(rnd() * 11);
    var honP = Math.floor(rnd() * 31);
    var jurosP = Math.round((rnd() * 2) * 100) / 100;
    var got = CalcEngine.juridica(valor, ini, fim, indice, multaP, honP, jurosP);
    var exp = legJuridica(valor, ini, fim, indice, multaP, honP, jurosP);
    near(got.valorAtualizado, exp.valorAtualizado, 'jur#' + i + ' valorAtualizado');
    near(got.juros, exp.juros, 'jur#' + i + ' juros');
    near(got.multa, exp.multa, 'jur#' + i + ' multa');
    near(got.honorarios, exp.honorarios, 'jur#' + i + ' honorarios');
    near(got.total, exp.total, 'jur#' + i + ' total');
    ok(got.mesesCorrigidos === exp.mesesCorrigidos, 'jur#' + i + ' mesesCorrigidos');
  }
})();

// ─────────────────── 3) Cobrança: fuzz 200 casos == oráculo ─────────────────
LOG('3) Cobranca: 200 casos aleatorios -- motor == formula original');
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
})();

// ─────────────────────────── 4) Âncoras conferidas à mão ────────────────────
LOG('4) Ancoras deterministicas');
(function () {
  var g = CalcEngine.juridica(1000, new Date(2025, 4, 1), new Date(2025, 6, 15), 'TJPR', 0, 0, 0);
  ok(g.aplicouGarantiaSTJ === true, 'garantia STJ acionada em serie negativa');
  ok(g.valorAtualizado === 1000, 'garantia STJ trava valorAtualizado no nominal (=' + g.valorAtualizado + ')');
  ok(g.total === 1000, 'sem multa/juros/hon e garantia: total == nominal');

  var m = CalcEngine.juridica(1000, new Date(2025, 0, 15), new Date(2025, 5, 15), 'INPC', 10, 20, 1);
  ok(m.mesesCorrigidos === 5, '15/jan->15/jun = 5 meses corrigidos (=' + m.mesesCorrigidos + ')');
  near(m.multa, m.valorAtualizado * 0.10, 'multa == 10% do atualizado');
  near(m.honorarios, (m.valorAtualizado + m.juros + m.multa) * 0.20, 'honorarios == 20% de (atual+juros+multa)');
  near(m.total, m.valorAtualizado + m.juros + m.multa + m.honorarios, 'total == soma das partes');

  var c = CalcEngine.cobranca({ valorOriginal: 1000, meses: 12, correcaoMensal: 0.08 / 12, jurosMensal: 0.01, multaPct: 0.02, taxaServico: 0.30, aplicarMulta: false, aplicarTaxa: false });
  ok(c.multa === 0, 'cobranca aplicarMulta=false -> multa 0');
  ok(c.taxa === 0, 'cobranca aplicarTaxa=false -> taxa 0');
  ok(c.total === Math.ceil(c.subtotal), 'cobranca total == ceil(subtotal) sem taxa');
  ok(c.total === Math.round(c.total), 'cobranca total e inteiro (arredonda pra cima)');
})();

// ─────────────────────────────────── fim ───────────────────────────────────
LOG(FAIL === 0
  ? '\nOK -- ' + RAN + ' assercoes passaram (matriz reproduz a formula original).'
  : '\nFALHOU -- ' + FAIL + '/' + RAN + ' assercao(oes).');
if (FAIL > 0) { if (typeof process !== 'undefined' && process.exit) process.exit(1); else throw new Error('calc-engine: ' + FAIL + ' falhas'); }
