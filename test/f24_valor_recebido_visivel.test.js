/*
 * Teste F-24 — linha quitada mostra o que de fato circulou.
 *
 * A 8/9 do Luiz Carlos de França tinha face R$ 252,00 e `valor_pago` R$ 378,08 (R$ 126,08
 * de juros do atraso). A lista de Movimentações imprimia sempre `l.valor`, então a tela
 * dizia R$ 252,00 e o Gustavo foi procurar onde tinham ido parar os R$ 126,08. Não era um
 * caso: 13 entradas quitadas estavam assim, R$ 510,51 invisíveis no total.
 *
 * Para linha QUITADA vale o valor recebido; a face segue na anotação ao lado. Linha
 * prevista, ou quitada pela face exata, não muda em nada — é o que os dois primeiros
 * casos abaixo travam, para o conserto não virar barulho nas ~900 linhas normais.
 *
 * Como rodar:
 *   node test/f24_valor_recebido_visivel.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function corta(marca, fim) {
  const i = HTML.indexOf(marca);
  assert.ok(i >= 0, `não achei no index.html: ${marca}`);
  const j = HTML.indexOf(fim, i + marca.length);
  assert.ok(j > i, `não achei o fim de ${marca}`);
  return HTML.slice(i, j + fim.length);
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  corta('const _finLancQuitado', '\n')
  + corta('function _finValorCirculado(l){', '\n}')
  + 'this._v = _finValorCirculado;',
  ctx
);
const v = ctx._v;

// 1. Previsto: sem valor_pago, vale a face e não há anotação.
let r = v({ valor: 252, valor_pago: null, status: 0 });
assert.strictEqual(r.v, 252, 'previsto deve exibir a face');
assert.strictEqual(r.extra, 0, 'previsto não tem acréscimo a anotar');

// 2. Quitado pela face exata: nada muda — o caso das ~900 linhas normais.
r = v({ valor: 244, valor_pago: 244, status: 1 });
assert.strictEqual(r.v, 244);
assert.strictEqual(r.extra, 0, 'pago pela face não deve ganhar anotação');

// 3. O caso do Luiz Carlos: face 252, recebido 378,08.
r = v({ valor: 252, valor_pago: 378.08, status: 1 });
assert.strictEqual(r.v, 378.08, 'quitado deve exibir o valor recebido');
assert.strictEqual(r.face, 252, 'a face segue disponível para a anotação');
assert.strictEqual(r.extra, 126.08, 'o acréscimo é a diferença');

// 4. Despesa: `valor_pago` é assinado igual a `valor`, os dois negativos. O abs nos dois
//    lados evita que a saída apareça como desconto gigante.
r = v({ valor: -100, valor_pago: -112.5, status: 1 });
assert.strictEqual(r.v, 112.5, 'saída paga a maior exibe o valor pago');
assert.strictEqual(r.extra, 12.5);

// 5. Recebido a MENOS que a face (desconto/parcial) — a diferença é negativa, não some.
r = v({ valor: 300, valor_pago: 280, status: 1 });
assert.strictEqual(r.v, 280);
assert.strictEqual(r.extra, -20, 'recebido a menos deve anotar diferença negativa');

// 6. Quitado por conciliação, sem status 1 nem data — `_finLancQuitado` cobre as três
//    portas, e a regra tem de enxergar todas.
r = v({ valor: 50, valor_pago: 55, status: 0, conciliado: true });
assert.strictEqual(r.v, 55, 'conciliado também é quitado');

// 7. Centavos: diferença abaixo de meio centavo é ruído de arredondamento, não acréscimo.
r = v({ valor: 100, valor_pago: 100.001, status: 1 });
assert.strictEqual(r.extra, 0, 'diferença sub-centavo não vira anotação');

console.log('F-24 ok — linha quitada mostra o valor recebido, previsto segue na face');
