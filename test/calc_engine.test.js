/*
 * Teste do motor canônico (templates/calc-engine.js) — v3 (pacote "Melhorias").
 *
 * Metodologia (regras invioláveis): capitalização simples (Súmula 121), GARANTIA
 * STJ (correção nunca reduz abaixo do nominal), pró-rata-die. Índices oficiais do
 * BCB (TJPR = média INPC/IGP-DI; TAXA-LEGAL Lei 14.905/24 oficial). Itens 14
 * (Taxa Legal) e 15 (escalonamento por período).
 *
 * Como rodar:
 *   node test/calc_engine.test.js
 *   jsc  templates/calc-engine.js test/calc_engine.test.js
 */
'use strict';
var LOG = (typeof print === 'function') ? print : console.log;
var E = (typeof require === 'function') ? require('../templates/calc-engine.js')
  : (typeof globalThis !== 'undefined' ? globalThis.CalcEngine : this.CalcEngine);

var RAN = 0, FAIL = 0;
function ok(c, m) { RAN++; if (!c) { FAIL++; LOG('  X ' + m); } }
function near(a, b, m, eps) { RAN++; if (!(Math.abs(a - b) <= (eps || 1e-6))) { FAIL++; LOG('  X ' + m + ' -- a=' + a + ' b=' + b); } }
function D(y, mo, d) { return new Date(y, mo, d); }
function mulberry32(s) { return function () { s |= 0; s = (s + 0x6D2B79F5) | 0; var t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// 1) TABELAS oficiais
LOG('1) Tabelas oficiais BCB + TJPR media + TAXA-LEGAL oficial');
(function () {
  var T = E.TABELAS;
  ok(['INPC', 'IPCA', 'IGP-M', 'IGP-DI', 'SELIC', 'TJPR', 'TAXA-LEGAL'].every(function (k) { return k in T; }), '7 tabelas presentes');
  near(T.INPC['2024-08'], -0.14, 'INPC 2024-08');
  near(T['IGP-DI']['2026-04'], 2.41, 'IGP-DI 2026-04');
  near(T.SELIC['2025-01'], 1.01, 'SELIC 2025-01');
  ['2025-06', '2026-04'].forEach(function (m) { near(T.TJPR[m], (T.INPC[m] + T['IGP-DI'][m]) / 2, 'TJPR ' + m + ' = media(INPC,IGP-DI)'); });
  near(T['TAXA-LEGAL']['2025-02'], 0.67092, 'TAXA-LEGAL 2025-02 oficial', 1e-4);
  ok(!('2024-08' in T['TAXA-LEGAL']), 'TAXA-LEGAL comeca em 2024-09 (Lei 14.905)');
  ok(('2000-01' in T.INPC) && Object.keys(T.INPC).length >= 300, 'INPC cobre 2000+ (300+ meses)');
})();

// 2) Garantia STJ (inviolável)
LOG('2) Garantia STJ: correcao nunca reduz abaixo do nominal');
(function () {
  var g = E.juridica(1000, D(2025, 4, 1), D(2025, 6, 15), 'TJPR', 0, 0, 0); // TJPR deflacionario mai-jul/2025
  ok(g.valorAtualizado >= 1000 - 1e-9, 'atualizado >= nominal (=' + g.valorAtualizado.toFixed(2) + ')');
  ok(g.aplicouGarantiaSTJ === true, 'aplicouGarantiaSTJ=true em serie negativa');
  var n = E.juridica(1000, D(2024, 0, 10), D(2025, 0, 10), 'INPC', 0, 0, 0); // INPC positivo no periodo
  ok(n.valorAtualizado > 1000, 'serie positiva: atualizado > nominal');
})();

// 3) Item 14 — Taxa Legal (Lei 14.905), cutoff 30/08/2024
LOG('3) Item 14: Taxa Legal pos-cutoff usa a tabela oficial; pre-cutoff usa juros fixos');
(function () {
  var pos = E.calcularPrincipal({ valorOriginal: 10000, dataCorrecao: D(2024, 8, 1), dataFim: D(2025, 8, 1), dataJuros: D(2024, 8, 1), indice: 'TAXA-LEGAL', taxaJurosMensal: 1, aplicarMulta: false, eventos: [] });
  var lins = pos.linhas.filter(function (l) { return l.tipo === 'mes'; });
  ok(lins.every(function (l) { return l.viaTaxaLegal; }), 'todos os meses pos-09/2024 via Taxa Legal');
  near(lins[0].taxaMesAplicada, 0.565815, 'set/2024 taxa legal = 0.5658', 1e-4);
  // pre-cutoff: juros fixos (1% a.m.), NAO via taxa legal
  var pre = E.calcularPrincipal({ valorOriginal: 10000, dataCorrecao: D(2024, 0, 1), dataFim: D(2024, 7, 1), dataJuros: D(2024, 0, 1), indice: 'TAXA-LEGAL', taxaJurosMensal: 1, aplicarMulta: false, eventos: [] });
  ok(pre.linhas.filter(function (l) { return l.tipo === 'mes'; }).every(function (l) { return !l.viaTaxaLegal; }), 'meses pre-09/2024 NAO via Taxa Legal');
})();

// 4) Item 15 — escalonamento por periodo
LOG('4) Item 15: regimes por periodo mudam o resultado');
(function () {
  var reg = E.juridica(10000, D(2024, 5, 1), D(2025, 5, 1), 'INPC', 0, 0, 0, { regimesIndice: [{ indice: 'INPC', dataFim: '2024-12-31' }, { indice: 'IGP-M', dataIni: '2025-01-01' }] });
  var soInpc = E.juridica(10000, D(2024, 5, 1), D(2025, 5, 1), 'INPC', 0, 0, 0);
  ok(Math.abs(reg.valorAtualizado - soInpc.valorAtualizado) > 1, 'regime INPC->IGP-M difere de so INPC');
  // juros por periodo
  var rj = E.juridica(10000, D(2024, 0, 1), D(2025, 0, 1), 'INPC', 0, 0, 1, { regimesJuros: [{ taxa: 2, dataIni: '2024-07-01' }] });
  var rj1 = E.juridica(10000, D(2024, 0, 1), D(2025, 0, 1), 'INPC', 0, 0, 1);
  ok(rj.juros > rj1.juros, 'juros 2% no 2o semestre > juros 1% o ano todo');
})();

// 5) Financiamento / CET (bissecao)
LOG('5) Financiamento: CET por bissecao');
(function () {
  var f = E.analisarFinanciamento({ valorFinanciado: 1000, nParcelas: 12, valorParcela: 100 });
  ok(f.totalPago === 1200 && f.jurosTotal === 200, 'total pago 1200, juros 200');
  near(f.cetMensal * 100, 2.9229, 'CET ~2.92% a.m.', 0.01);
  near(f.cetAnual * 100, 41.30, 'CET ~41.3% a.a.', 0.1);
  var semJuros = E.analisarFinanciamento({ valorFinanciado: 1200, nParcelas: 12, valorParcela: 100 });
  ok(semJuros.cetMensal === 0, 'parcelas == principal -> CET 0');
})();

// 6) Cobrança extrajudicial — fórmula inalterada (fuzz 200 vs oráculo)
LOG('6) Cobranca: 200 casos vs formula original');
(function () {
  function leg(v, meses, cm, jm, mp, ts, aM, aT) { var c = v * cm * meses, vc = v + c, j = vc * jm * meses, mu = aM ? vc * mp : 0, sub = vc + j + mu, tx = aT ? sub * ts : 0; return { total: Math.ceil(sub + tx), subtotal: sub }; }
  var rnd = mulberry32(987654321);
  for (var i = 0; i < 200; i++) {
    var v = Math.round((300 + rnd() * 50000) * 100) / 100, meses = Math.round(rnd() * 60 * 1e6) / 1e6;
    var aM = rnd() > 0.5, aT = rnd() > 0.5;
    var got = E.cobranca({ valorOriginal: v, meses: meses, correcaoMensal: 0.08 / 12, jurosMensal: 0.01, multaPct: 0.02, taxaServico: 0.30, aplicarMulta: aM, aplicarTaxa: aT });
    var exp = leg(v, meses, 0.08 / 12, 0.01, 0.02, 0.30, aM, aT);
    near(got.subtotal, exp.subtotal, 'cob#' + i + ' subtotal'); ok(got.total === exp.total, 'cob#' + i + ' total');
  }
})();

// 7) Judicial — parcelas extras + multa/honorarios sobre a soma
LOG('7) Judicial: parcelas extras, multa/honorarios sobre a soma');
(function () {
  var j = E.calcularJudicial({ valorOriginal: 5000, dataCorrecao: D(2024, 0, 10), dataFim: D(2025, 0, 10), dataJuros: D(2024, 0, 10), indice: 'INPC', taxaJurosMensal: 1, aplicarMulta: true, multaTipo: 'PCT', multaPct: 10, multaBase: 'CORRIGIDO', eventos: [], parcelasExtras: [{ valor: '2000', dataCorr: '2024-06-01' }], honC: { ativo: true, tipo: 'PCT', valor: 10, base: 'CORRIGIDO_JUROS_MULTA' } });
  ok(j.parcelasResultados.length === 1, '1 parcela extra computada');
  near(j.multaAgregada, j.saldoCorrigidoTotal * 0.10, 'multa 10% sobre saldo corrigido total');
  near(j.totalHonC, (j.saldoCorrigidoTotal + j.jurosAcumuladosTotal + j.multaAgregada) * 0.10, 'honC 10% sobre (corr+juros+multa)');
  near(j.totalGeral, j.totalPrincipal + j.totalHonC, 'total geral = principal + honC');
})();

LOG(FAIL === 0 ? '\nOK -- ' + RAN + ' assercoes passaram (motor canonico v3).' : '\nFALHOU -- ' + FAIL + '/' + RAN + ' assercao(oes).');
if (FAIL > 0) { if (typeof process !== 'undefined' && process.exit) process.exit(1); else throw new Error('calc-engine: ' + FAIL + ' falhas'); }
