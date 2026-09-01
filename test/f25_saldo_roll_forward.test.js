/*
 * Teste F-25 — saldo da conta anda sozinho a partir da âncora bancária.
 *
 * A conta Asaas passou 25 dias exibindo R$ 4.893,82. A precedência do saldo era
 * "declarado > razão > saldo inicial", e o declarado (`fin_conta.bank_balance`) só muda
 * quando alguém importa um OFX — então o número congelava e nada o movia. Em 31/08/2026 o
 * saldo real era R$ 9.592,26.
 *
 * Trocar pelo saldo do razão não resolveria: `saldo_inicial` já embute a posição de uma data
 * de corte, e os lançamentos anteriores a ela são somados por cima. Na Asaas isso dava
 * R$ 19.845,16, porque 25 lançamentos pagos antes de 01/08 entravam em dobro.
 *
 * A regra é roll-forward: âncora + o que se moveu depois dela. Este teste fixa os quatro
 * comportamentos da função, com os números reais do caso que a originou.
 *
 * Como rodar:
 *   node test/f25_saldo_roll_forward.test.js
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
  corta('function _finSaldoDaConta(c, saldosByConta){', '\n}')
  + 'this._saldo = _finSaldoDaConta;',
  ctx
);
const saldo = ctx._saldo;

// 1) Com âncora e movimento posterior: soma os dois. Números reais da conta Asaas em 31/08 —
//    âncora de R$ 8.934,24 (LEDGERBAL do extrato) e os dois Pix do dia menos as tarifas.
{
  const conta = { id: 13, bank_balance: 8934.24, saldo_inicial: 3462.82 };
  const rpc = { 13: { saldo_atual: 19845.16, realizado_pos_ancora: 658.02 } };
  assert.strictEqual(+saldo(conta, rpc).toFixed(2), 9592.26,
    'âncora + movimento posterior deveria dar o saldo real de 31/08');
}

// 2) A âncora sozinha não é o saldo. É o defeito que originou a mudança: sem somar o que veio
//    depois, a tela mostrava o valor de 25 dias atrás.
{
  const conta = { id: 13, bank_balance: 4893.82, saldo_inicial: 3462.82 };
  const rpc = { 13: { saldo_atual: 19845.16, realizado_pos_ancora: 5394.19 } };
  assert.notStrictEqual(+saldo(conta, rpc).toFixed(2), 4893.82,
    'o saldo não pode ser a âncora crua — era esse o congelamento');
  assert.strictEqual(+saldo(conta, rpc).toFixed(2), 10288.01);
}

// 3) Sem âncora, cai no saldo do razão — comportamento de antes, preservado.
{
  const conta = { id: 4, bank_balance: null, saldo_inicial: 100 };
  const rpc = { 4: { saldo_atual: 525.78, realizado_pos_ancora: 0 } };
  assert.strictEqual(saldo(conta, rpc), 525.78, 'sem âncora vale o razão');
}

// 4) Sem âncora e sem razão, o saldo inicial. E conta ausente não quebra.
{
  assert.strictEqual(saldo({ id: 9, bank_balance: null, saldo_inicial: 42 }, {}), 42);
  assert.strictEqual(saldo(null, {}), 0);
}

// 5) RPC antiga, sem a coluna `realizado_pos_ancora` (migração ainda não aplicada): não pode
//    dar NaN nem somar undefined — devolve a âncora crua, que é o comportamento anterior.
{
  const conta = { id: 13, bank_balance: 8934.24, saldo_inicial: 0 };
  const rpc = { 13: { saldo_atual: 19845.16 } };
  assert.strictEqual(saldo(conta, rpc), 8934.24,
    'sem a coluna nova a função tem que degradar para a âncora, não para NaN');
}

// 6) Movimento negativo posterior à âncora (mês só de saídas) reduz o saldo.
{
  const conta = { id: 13, bank_balance: 1000, saldo_inicial: 0 };
  const rpc = { 13: { saldo_atual: 0, realizado_pos_ancora: -250.5 } };
  assert.strictEqual(saldo(conta, rpc), 749.5);
}

console.log('F-25 ok — saldo da conta faz roll-forward a partir da âncora');
