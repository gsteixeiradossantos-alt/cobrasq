/*
 * Teste F-48 — repasse Mac → djen-intimacoes (scripts/djen-intimacoes-lotes.mjs).
 *
 * O DJEN dá 403 ao Supabase desde 13/09/2026; o Mac baixa e repassa à função em
 * lotes. Este teste trava:
 *   1) só o ÚLTIMO lote leva finalizar:true (cruzar + timeline uma vez só);
 *   2) lote de no máximo `tamanho` itens, sem perder nem repetir item;
 *   3) OAB com erro no DJEN vai como erro, não como "zero comunicações";
 *   4) a soma das respostas por OAB.
 *
 * Como rodar:
 *   node test/f48_djen_intimacoes_lotes.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const L = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'djen-intimacoes-lotes.mjs')).href);
  const itens = (n, p) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}` }));

  // partirOab
  assert.deepStrictEqual(L.partirOab('112743/PR'), { numero: '112743', uf: 'PR' });
  assert.deepStrictEqual(L.partirOab(' 119424/pr '), { numero: '119424', uf: 'PR' });
  assert.strictEqual(L.partirOab('112743'), null);
  assert.strictEqual(L.partirOab(''), null);

  // 1 e 2) 250 itens da OAB A + 30 da B, lotes de 100 → 3 + 1 corpos
  const corpos = L.montarRepasses(
    [{ oab: '112743/PR', itens: itens(250, 'a') }, { oab: '119424/PR', itens: itens(30, 'b') }],
    { inicio: '2026-09-10', fim: '2026-09-26', tamanho: 100 });
  assert.strictEqual(corpos.length, 4);
  assert.deepStrictEqual(corpos.map(c => c.finalizar), [false, false, false, true]);
  assert.ok(corpos.every(c => c.modo === 'resultados' && c.inicio === '2026-09-10' && c.fim === '2026-09-26'));
  assert.deepStrictEqual(corpos.map(c => c.resultados[0].itens.length), [100, 100, 50, 30]);
  const ids = corpos.flatMap(c => c.resultados[0].itens.map(i => i.id));
  assert.strictEqual(new Set(ids).size, 280);

  // 3) erro numa OAB e zero na outra
  const c2 = L.montarRepasses([{ oab: '112743/PR', erro: 'DJEN HTTP 403' }, { oab: '119424/PR', itens: [] }], { inicio: 'i', fim: 'f' });
  assert.strictEqual(c2.length, 2);
  assert.deepStrictEqual(c2[0].resultados, [{ oab: '112743/PR', erro: 'DJEN HTTP 403' }]);
  assert.deepStrictEqual(c2[1].resultados, [{ oab: '119424/PR', itens: [] }]);
  assert.strictEqual(c2[1].finalizar, true);

  // sem nada: ainda um corpo finalizador (cruza e grava eventos pendentes)
  const c3 = L.montarRepasses([], { inicio: 'i', fim: 'f' });
  assert.deepStrictEqual(c3, [{ modo: 'resultados', inicio: 'i', fim: 'f', resultados: [], finalizar: true }]);

  // 4) soma
  const s = L.somarRespostas([
    { novas: 3, oabs: { '112743/PR': { total: 100, novas: 3, repetidas: 97, erros: 0 } } },
    { novas: 1, oabs: { '112743/PR': { total: 50, novas: 1, repetidas: 48, erros: 1 } } },
    { novas: 0, oabs: { '119424/PR': { erro: 'no Mac: DJEN HTTP 403' } }, cruzadas: 2, eventos: 1 },
  ]);
  assert.strictEqual(s.novas, 4);
  assert.deepStrictEqual(s.oabs['112743/PR'], { total: 150, novas: 4, repetidas: 145, erros: 1 });
  assert.strictEqual(s.oabs['119424/PR'].erro, 'no Mac: DJEN HTTP 403');
  assert.strictEqual(s.cruzadas, 2);
  assert.strictEqual(s.eventos, 1);

  console.log('F-48 djen-intimacoes lotes: OK');
})().catch(e => { console.error(e); process.exit(1); });
