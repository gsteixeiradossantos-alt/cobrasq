/*
 * Teste F-60 (cliente com dois telefones).
 *
 * O cadastro do cliente ganhou "Telefone 2" (metadata.telefone2). O campo Telefone
 * continua sendo o do WhatsApp. Contrato:
 *  - rowToCliente → clienteToRow devolve o telefone2 intacto;
 *  - objeto sem `tel2` (blob, importação, upsert em massa) PRESERVA o do servidor;
 *  - a tela, que manda tel2 = '', consegue apagá-lo.
 *
 *   node test/f60_cliente_telefone2.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function fn(nome) {
  const i = HTML.indexOf('function ' + nome + '(');
  assert.ok(i >= 0, 'não achei ' + nome);
  const j = HTML.indexOf('\n}\n', i);
  return HTML.slice(i, j + 2);
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext([fn('clienteToRow'), fn('rowToCliente')].join('\n') +
  '\nfunction _cliTel2' + HTML.split('function _cliTel2')[1].split('\n')[0], ctx);

const row = { id: 'x', nome: 'Oxipar', telefone: '4699143259', metadata: { obs: '', telefone2: '4635365077', pix_key: 'k' } };
const c = ctx.rowToCliente(row);
assert.strictEqual(c.tel2, '4635365077', 'rowToCliente não leu o telefone2');
assert.strictEqual(ctx.clienteToRow(c).metadata.telefone2, '4635365077', 'round-trip perdeu o telefone2');
assert.strictEqual(ctx.clienteToRow(c).telefone, '4699143259', 'o telefone principal mudou');

const semTel2 = Object.assign({}, c); delete semTel2.tel2;
assert.strictEqual(ctx.clienteToRow(semTel2).metadata.telefone2, '4635365077', 'objeto sem tel2 apagou o do servidor');

assert.strictEqual(ctx.clienteToRow(Object.assign({}, c, { tel2: '' })).metadata.telefone2, '', 'a tela não consegue apagar');
assert.strictEqual(ctx._cliTel2(row), '4635365077', '_cliTel2 não lê a linha');
assert.ok(/id="mcli-tel2"/.test(HTML), 'falta o campo Telefone 2 no formulário');

console.log('F-60 ok: Telefone 2 do cliente sobrevive ao round-trip e só a tela o apaga.');
