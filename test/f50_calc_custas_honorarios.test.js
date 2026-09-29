/*
 * Teste F-50 — calculadora jurídica: custas processuais, honorários e rito JEC (calc-juridica.html).
 *
 * Caso de aceite (conferido contra o unificar-memoria.py da skill acao-judicial-cobrasq):
 * R$ 8.343,00 de 06/01/2024 a 28/09/2026, TJPR (média INPC/IGP-DI), juros simples de 1% a.m.,
 * sem multa, honorários de 10% sobre o saldo total; 13 custas pagas (corrigidas desde o recolhimento,
 * sem juros) e 3 × R$ 30,00 de expedição a recolher (nominal).
 *   saldo total 12.121,15 · custas 1.462,32 (pagas 1.337,57 + correção 34,75 + 90,00)
 *   honorários 1.212,12 · total 14.795,59
 *
 * Como rodar:
 *   node test/f50_calc_custas_honorarios.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const E = require(path.join(__dirname, '..', 'templates', 'calc-engine.js'));
const HTML = fs.readFileSync(path.join(__dirname, '..', 'calc-juridica.html'), 'utf8');
function trecho(inicio) {
  const ini = HTML.indexOf(inicio);
  assert.ok(ini >= 0, inicio + ' não existe mais no calc-juridica.html');
  return HTML.slice(ini, HTML.indexOf('\n}', ini) + 2);
}
function bloco(inicio, fim) {
  const ini = HTML.indexOf(inicio);
  assert.ok(ini >= 0, inicio + ' não existe mais no calc-juridica.html');
  return HTML.slice(ini, HTML.indexOf(fim, ini));
}

const ctx = { E, B: E.fmtBRL, N: E.fmtNum, fmtData: E.fmtData,
  esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) };
vm.createContext(ctx);
vm.runInContext(trecho('function consolidarCustasHon(r){'), ctx);
vm.runInContext(bloco('var M3_CSS=', '// ════════ EXPORT PDF'), ctx);

const p = E.parseDataLocal;
const pagas = [['2025-08-12', 56.28, 'mov. 12'], ['2025-08-12', 79.20, 'mov. 13'], ['2025-08-25', 637.10, 'preparo'],
  ['2025-08-28', 54.31, ''], ['2025-08-28', 193.09, ''], ['2025-09-01', 18.46, ''], ['2026-03-30', 30, ''],
  ['2026-04-29', 54.31, ''], ['2026-04-29', 30, ''], ['2026-07-16', 16.19, ''], ['2026-07-16', 30, ''],
  ['2026-08-24', 30, ''], ['2026-08-24', 108.63, '']];
const params = { valorOriginal: 8343, dataCorrecao: p('2024-01-06'), dataFim: p('2026-09-28'), dataJuros: p('2024-01-06'),
  indice: 'TJPR', taxaJurosMensal: 1, aplicarMulta: false, multaPct: 0, eventos: [], parcelasExtras: [],
  custas: pagas.map((c) => ({ descricao: c[2], data: c[0], valor: c[1] })),
  honC: { ativo: true, tipo: 'PCT', valor: 10, base: 'CORRIGIDO_JUROS_MULTA' } };
const r = E.calcularJudicial(params, E.TABELAS);
r.params = params;
r.custasRecolher = [1, 2, 3].map(() => ({ descricao: 'expedição', valor: 30 }));
const cons = ctx.consolidarCustasHon(r);

assert.strictEqual(cons.saldoTotal, 12121.15, 'saldo total');
assert.strictEqual(cons.pagasNominal, 1337.57, 'custas pagas (nominal)');
assert.strictEqual(cons.correcaoCustas, 34.75, 'correção das custas');
assert.strictEqual(cons.recolher, 90, 'a recolher');
assert.strictEqual(cons.custas, 1462.32, 'custas processuais');
assert.strictEqual(cons.honorarios, 1212.12, 'honorários (10% sobre o saldo total, sem custas)');
assert.strictEqual(cons.total, 14795.59, 'saldo total geral');
console.log('  ✔ aceite: 12.121,15 + 1.462,32 + 1.212,12 = 14.795,59');

// memória em 3 folhas: coluna de custas, referência cinza, a recolher no último mês, fechamento
const m3 = ctx.memoria3Folhas(r, cons, {});
const tabela = m3.thead + m3.chunks.map((c) => c.join('')).join('');
assert.ok(/Custas<br>processuais/.test(m3.thead), 'coluna "Custas processuais"');
assert.ok(tabela.includes('+ ' + E.fmtBRL(1019.98)) && tabela.includes('ref. (mov. 12 e 13;<br>preparo)'), 'ago/25: soma nominal + ref.');
assert.ok(tabela.includes('expedição a recolher<br>(3 × ' + E.fmtBRL(30) + ')'), 'a recolher no último mês');
assert.ok(m3.fecho.includes('Fechamento em 28/09/2026') && m3.fecho.includes('Saldo total geral') &&
  m3.fecho.includes(E.fmtBRL(14795.59)), 'fechamento');
assert.ok(m3.comp.includes('Honorários advocatícios (10% sobre o saldo total)'), 'linha de honorários');
assert.ok(m3.comp.includes('Custas processuais (13 recolhimentos, corrigidos pela média INPC/IGP-DI, sem juros, e expedição a recolher'), 'linha de custas');
console.log('  ✔ memória em 3 folhas (tabela com custas e fechamento)');

// sem custas: a coluna some
const r0 = E.calcularJudicial(Object.assign({}, params, { custas: [] }), E.TABELAS);
r0.params = params; r0.custasRecolher = [];
const m30 = ctx.memoria3Folhas(r0, ctx.consolidarCustasHon(r0), {});
assert.ok(!/Custas<br>processuais/.test(m30.thead), 'sem custas não há coluna de custas');
console.log('  ✔ sem custas, sem coluna');

// rito JEC e base dos honorários
assert.ok(HTML.includes('JEC, 1º grau: sem custas e honorários (arts. 54 e 55 da Lei 9.099/95), salvo acórdão da Turma Recursal ou as exceções do art. 55, parágrafo único.'), 'nota do JEC');
assert.ok(HTML.includes("base:'CORRIGIDO_JUROS_MULTA'"), 'honorários sobre principal corrigido + multa + juros');
assert.ok(!HTML.includes("base:'CORRIGIDO_JUROS'}"), 'base antiga (sem multa) removida');
console.log('  ✔ rito JEC e base dos honorários');
console.log('F-50 OK');
