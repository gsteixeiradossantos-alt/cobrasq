/*
 * Teste F-61 (DataJud — processos vinculados entram no monitoramento).
 *
 * Os desdobramentos da cobrança (cobranca_processos_vinculados, 06/10/2026) com número
 * e monitorar_datajud=true são consultados junto com o principal, uma vez por número,
 * e o andamento vai para a cobrança dona. Sem número, fora do TJPR ou repetido: não
 * gera consulta extra.
 *
 *   node test/f61_datajud_processos_vinculados.test.js
 */
'use strict';
const assert = require('assert');
const { montarAlvos } = require('../api/cron-datajud.js');

const VALERY = '3f1335d1-75fe-4f8d-b61a-6964f206b540';
const OUTRA = '56b2e5c9-a55c-414c-8c53-77746fe84b31';

const cobrancas = [
  { id: VALERY, numero_processo: '0000961-75.2021.8.16.0068' },
  { id: OUTRA, numero_processo: '0002882-34.2021.8.16.0209' },
];
const vinculados = [
  { cobranca_id: VALERY, numero_processo: '0000505-91.2022.8.16.0068', rotulo: 'Embargos de Terceiro' },
  // acordo no mesmo processo do principal: não consulta de novo
  { cobranca_id: VALERY, numero_processo: '0000961-75.2021.8.16.0068', rotulo: 'Acordo 2' },
  { cobranca_id: OUTRA, numero_processo: '00038359520218160209', rotulo: 'Processo relacionado (Astrea)' },
  // fora do TJPR (TRT) e sem número: fora
  { cobranca_id: OUTRA, numero_processo: '0000123-45.2023.5.09.0001', rotulo: 'Reclamatória' },
  { cobranca_id: OUTRA, numero_processo: null, rotulo: 'Acordo extrajudicial' },
];

const alvos = montarAlvos(cobrancas, vinculados);
assert.strictEqual(alvos.length, 4, 'esperava 2 principais + 2 vinculados, veio ' + alvos.length);

const emb = alvos.find((a) => a.formatado === '0000505-91.2022.8.16.0068');
assert.ok(emb, 'embargos de terceiro fora do monitoramento');
assert.strictEqual(emb.cobrancaId, VALERY);
assert.strictEqual(emb.origem, 'vinculado');
assert.strictEqual(emb.rotulo, 'Embargos de Terceiro');

const princ = alvos.filter((a) => a.digitos === '00009617520218160068');
assert.strictEqual(princ.length, 1, 'número igual ao principal consultado duas vezes');
assert.strictEqual(princ[0].origem, 'principal');

const astrea = alvos.find((a) => a.digitos === '00038359520218160209');
assert.ok(astrea, 'vinculado gravado só com dígitos não entrou');
assert.strictEqual(astrea.formatado, '0003835-95.2021.8.16.0209', 'número tem de sair completo e formatado');
assert.strictEqual(astrea.cobrancaId, OUTRA);

// sem vinculados (tabela ainda não migrada): comportamento antigo
assert.strictEqual(montarAlvos(cobrancas, []).length, 2);
assert.strictEqual(montarAlvos(cobrancas, undefined).length, 2);

console.log('F-61 ok: principal + vinculados, sem repetir número (' + alvos.length + ' consultas)');
