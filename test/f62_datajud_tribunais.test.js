/*
 * Teste F-62 (DataJud — TJSC além do TJPR).
 *
 * O mapa "J.TR" -> alias do DataJud cobre 8.16 (tjpr) e 8.24 (tjsc); tribunal fora do
 * mapa continua ignorado, e o TJPR segue com a mesma URL de antes.
 *
 *   node test/f62_datajud_tribunais.test.js
 */
'use strict';
const assert = require('assert');
const { montarAlvos, aliasTribunal, urlDataJud } = require('../api/cron-datajud.js');

assert.strictEqual(aliasTribunal('00009617520218160068'), 'tjpr');
assert.strictEqual(aliasTribunal('00009617520218240068'), 'tjsc');
assert.strictEqual(aliasTribunal('00009617520218260068'), null); // TJSP: não mapeado
assert.strictEqual(aliasTribunal('00009617520214036100'), null); // Justiça Federal
assert.strictEqual(aliasTribunal('123'), null);
assert.strictEqual(aliasTribunal(null), null);

// TJPR: URL idêntica à de antes da mudança
assert.strictEqual(urlDataJud('tjpr'), 'https://api-publica.datajud.cnj.jus.br/api_publica_tjpr/_search');
assert.strictEqual(urlDataJud('tjsc'), 'https://api-publica.datajud.cnj.jus.br/api_publica_tjsc/_search');

const alvos = montarAlvos([
  { id: 'a', numero_processo: '0000961-75.2021.8.16.0068' },
  { id: 'b', numero_processo: '0001234-56.2022.8.24.0023' },
  { id: 'c', numero_processo: '0001234-56.2022.8.26.0100' },
], []);
assert.deepStrictEqual(alvos.map((x) => x.cobrancaId), ['a', 'b']);
assert.strictEqual(alvos[1].formatado, '0001234-56.2022.8.24.0023');

console.log('f62 ok');
