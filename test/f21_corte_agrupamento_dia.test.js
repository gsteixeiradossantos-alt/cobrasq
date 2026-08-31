/*
 * Teste F-21 — o cabeçalho de dia aparece a partir de 4 linhas.
 *
 * O corte era 8, e fazia a MESMA tela mudar de estrutura conforme o filtro, sem dizer por
 * quê: Juliana Pinto Ribeiro (15 linhas) saía em cascata de dias, Claudete Aparecida da
 * Silva (7) saía corrida. Junto com o cabeçalho ia embora o SALDO DO DIA — e a Claudete
 * tem entrada e saída no mesmo 06/10, que é exatamente quando esse número importa.
 *
 * O corte não pode simplesmente sumir: a outra metade da condição é a ordenação. Agrupar
 * por dia só faz sentido ordenando por DATA; em qualquer outra coluna a cascata é desfeita
 * de propósito (senão o maior valor não apareceria no topo e a tela pareceria quebrada).
 *
 * Como rodar:
 *   node test/f21_corte_agrupamento_dia.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const m = HTML.match(/const agrupado = s\.ord\.col === 'data' && pagina\.length >= (\d+);/);
assert.ok(m, 'não achei a condição de agrupamento por dia em renderFinLancamentosCascata');
const corte = Number(m[1]);

assert.strictEqual(corte, 4, 'o corte do cabeçalho de dia é 4 linhas');

// A regra, exercitada como a tela a aplica.
const agrupa = (col, n) => col === 'data' && n >= corte;

// O caso Claudete: 7 linhas passaram a agrupar.
assert.strictEqual(agrupa('data', 7), true, 'Claudete (7 linhas) agora agrupa');
// O caso Juliana continua agrupando.
assert.strictEqual(agrupa('data', 15), true);
// E o piso: 4 agrupa, 3 não.
assert.strictEqual(agrupa('data', 4), true, 'no piso, agrupa');
assert.strictEqual(agrupa('data', 3), false, 'abaixo do piso, lista corrida');
assert.strictEqual(agrupa('data', 0), false);

// A outra metade da condição não pode ter se perdido: fora da ordenação por data, a
// cascata é desfeita mesmo com muitas linhas.
assert.strictEqual(agrupa('valor', 60), false, 'ordenar por valor desfaz a cascata de dias');
assert.strictEqual(agrupa('descricao', 60), false);
assert.strictEqual(agrupa('situacao', 60), false);

// E o cabeçalho continua existindo para ser desenhado.
assert.ok(HTML.includes('function _finLancCascataDiaHtml(g, ctx){'),
  'o cabeçalho de dia precisa continuar existindo');
assert.ok(/porDia\.map\(g=>_finLancCascataDiaHtml\(g, ctx\)\)/.test(HTML),
  'e continuar sendo o que a lista desenha quando agrupada');

console.log('F-21 ok — cabeçalho de dia a partir de 4 linhas, e só ordenando por data.');
