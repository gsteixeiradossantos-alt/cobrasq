/*
 * Teste F-36 — vistosPageCss (termo-engine.js): visto (rubrica) do devedor em
 * todas as páginas do termo de acordo.
 *
 * O caso: o Gustavo pediu (12/09/2026) que o ZapSign carimbe um visto pequeno em
 * cada página, sem atrapalhar o texto, para 1..N devedores. O caminho escolhido é
 * a âncora de texto <<vistodevN>> impressa nas caixas de margem do @page (o
 * Chromium do Gotenberg imprime `content` de margin box como texto real em todas
 * as páginas) + `rubrica_placement` no signatário (gerar-acordo-termo/index.ts).
 *
 * O que se garante aqui:
 *  - 0 devedor → nada (não polui o @page);
 *  - 1 âncora por devedor, numerada 1..N, cada uma UMA vez;
 *  - duas por caixa, na ordem bottom-left, bottom-right, top-left, top-right;
 *  - Arial e sem letter-spacing (fonte via data: vira Type 3 e quebra a âncora em
 *    trechos — o ZapSign carimba uma vez por trecho; ver #719), nowrap (a caixa
 *    lateral encolhe quando o centro tem texto longo e a 2ª âncora ia para a
 *    linha de baixo, em cima da 1ª);
 *  - teto de 8 devedores (4 caixas × 2) — o 9º fica sem visto, sem estourar.
 */
const path = require('path');
const assert = require('assert');

require(path.join(__dirname, '..', 'templates', 'termo-engine.js'));
const { vistosPageCss, placeholders } = globalThis.TermoEngine;

const conta = (s, re) => (s.match(re) || []).length;

// 0 → vazio
assert.strictEqual(vistosPageCss(0), '');
assert.strictEqual(vistosPageCss(undefined), '');
console.log('  ok   sem devedor → sem bloco @page');

// 1 → só bottom-left, uma âncora
const c1 = vistosPageCss(1);
assert.ok(/^@page\{/.test(c1));
assert.strictEqual(conta(c1, /<<vistodev1>>/g), 1);
assert.strictEqual(conta(c1, /@bottom-left\{/g), 1);
assert.strictEqual(conta(c1, /@bottom-right\{/g), 0);
console.log('  ok   1 devedor → 1 âncora em @bottom-left');

// 3 → 2 na esquerda, 1 na direita; cada âncora exatamente uma vez
const c3 = vistosPageCss(3);
assert.ok(/@bottom-left\{ content:"<<vistodev1>> <<vistodev2>>"/.test(c3));
assert.ok(/@bottom-right\{ content:"<<vistodev3>>"/.test(c3));
for (let i = 1; i <= 3; i++) assert.strictEqual(conta(c3, new RegExp('<<vistodev' + i + '>>', 'g')), 1, 'vistodev' + i);
assert.strictEqual(conta(c3, /<<vistodev4>>/g), 0);
console.log('  ok   3 devedores → 2 em @bottom-left + 1 em @bottom-right, sem repetir');

// estilo: Arial, letter-spacing 0, nowrap, embaixo da caixa
assert.ok(/font-family:Arial,Helvetica,sans-serif/.test(c3));
assert.ok(/letter-spacing:0;/.test(c3));
assert.ok(/white-space:nowrap/.test(c3));
assert.ok(/vertical-align:bottom/.test(c3));
assert.ok(!/data:/.test(c3), 'âncora nunca em fonte via data:');
console.log('  ok   Arial · letter-spacing 0 · nowrap · vertical-align bottom');

// 5 → chega às caixas de cima na ordem certa
const c5 = vistosPageCss(5);
assert.ok(/@top-left\{ content:"<<vistodev5>>"/.test(c5));
assert.strictEqual(conta(c5, /@top-right\{/g), 0);
// 9 → teto de 8: não estoura e não inventa 5ª caixa
const c9 = vistosPageCss(9);
assert.strictEqual(conta(c9, /<<vistodev\d+>>/g), 8);
assert.strictEqual(conta(c9, /<<vistodev9>>/g), 0);
assert.ok(/@top-right\{ content:"<<vistodev7>> <<vistodev8>>"/.test(c9));
console.log('  ok   5º devedor → @top-left; 9º fica sem visto (teto 8, 4 caixas × 2)');

// placeholders() expõe o bloco pelo nº real de devedores
const devs = [1, 2].map((i) => ({ nome: 'Dev ' + i, documento: '000.000.000-0' + i }));
const map = placeholders({ credor: { nome: 'COBRASQ' }, devedores: devs, acordo: { total: '100,00', parcelas: '1' } });
assert.strictEqual(map.vistosPageCss, vistosPageCss(2));
console.log('  ok   placeholders().vistosPageCss acompanha dados.devedores');

console.log('\nF-36 ok — visto por página: 1 âncora por devedor, 2 por caixa, Arial, teto 8.');
