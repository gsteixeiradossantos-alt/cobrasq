/*
 * Teste F-28 — frasePagamento (termo-engine.js) descreve faixas de valor
 * diferentes no texto do Termo de Acordo, sem mudar a frase de quem não usa
 * faixas.
 *
 * O caso: o assistente "⚖ Termo de acordo" só sabia gerar "N parcelas no
 * valor de R$X cada" — um parcelamento uniforme. Um acordo com faixas (ex.:
 * entrada + 3x R$300 + 12x R$400, registrado pelo "Novo Acordo") não tinha
 * como ser descrito corretamente no documento que a devedora assina: o texto
 * ficava errado (uniforme) mesmo com o registro financeiro certo.
 *
 * Este teste trava as duas coisas: a frase nova, com faixas — e que a frase
 * de sempre (parcelamento uniforme, com/sem entrada, 1 ou N parcelas) sai
 * IDÊNTICA a antes desta mudança.
 *
 * Como rodar:
 *   node test/f28_termo_frase_pagamento.test.js
 */
'use strict';

const path = require('path');
const assert = require('assert');

require(path.join(__dirname, '..', 'templates', 'termo-engine.js'));
const { frasePagamento } = globalThis.TermoEngine;

let falhas = 0;
function checa(nome, fn) {
  try { fn(); console.log('  ok   ' + nome); }
  catch (e) { falhas++; console.log('  FALHA ' + nome + '\n        ' + e.message); }
}

console.log('\nF-28 · frasePagamento descreve faixas de valor, sem mudar a frase de sempre\n');

// ── Comportamento de SEMPRE (parcelamento uniforme) — tem que sair igual ────
checa('1 parcela, sem entrada — frase igual à de antes', () => {
  const f = frasePagamento({ parcelas: 1, valorParcela: 1000, vencimento: '2026-10-10' });
  assert.strictEqual(f, 'mediante o pagamento de 1 (uma) parcela mensal no valor de <strong>R$ 1.000,00 (mil reais)</strong>, sendo que a primeira parcela será considerada vencida em <strong>10 de outubro de 2026</strong>');
});

checa('N parcelas, sem entrada — frase igual à de antes', () => {
  const f = frasePagamento({ parcelas: 5, valorParcela: 280, vencimento: '2026-10-10' });
  assert.ok(/^mediante o pagamento de 5 \(cinco\) parcelas mensais e sucessivas no valor de <strong>R\$ 280,00/.test(f), f);
  assert.ok(/<\/strong> cada, sendo que a primeira parcela será considerada vencida em/.test(f), f);
});

checa('com entrada, 1 parcela remanescente — frase igual à de antes (sem "cada")', () => {
  const f = frasePagamento({ parcelas: 1, valorParcela: 1000, vencimento: '2026-10-10', entrada: { valor: 500, vencimento: '2026-09-10' } });
  assert.ok(/e o remanescente em 1 \(uma\) parcela mensal no valor de <strong>R\$ 1\.000,00[^<]*<\/strong>, sendo que/.test(f), f);
});

checa('com entrada, N parcelas remanescentes — frase igual à de antes (com "cada")', () => {
  const f = frasePagamento({ parcelas: 3, valorParcela: 300, vencimento: '2026-10-10', entrada: { valor: 250, vencimento: '2026-09-10' } });
  assert.ok(/mediante o pagamento de uma entrada de <strong>R\$ 250,00/.test(f), f);
  assert.ok(/e o remanescente em 3 \(três\) parcelas mensais e sucessivas no valor de <strong>R\$ 300,00[^<]*<\/strong> cada, sendo que/.test(f), f);
});

// ── Faixas de valor diferentes (a feature nova) ─────────────────────────────
checa('2 faixas, sem entrada — descreve as duas, "seguidas de"', () => {
  const f = frasePagamento({ vencimento: '2026-10-10', faixas: [{ qtd: 3, valor: 300 }, { qtd: 12, valor: 400 }] });
  assert.ok(/^mediante o pagamento de 3 \(três\) parcelas mensais e sucessivas no valor de <strong>R\$ 300,00[^<]*<\/strong> cada, seguidas de 12 \(doze\) parcelas mensais e sucessivas no valor de <strong>R\$ 400,00[^<]*<\/strong> cada, sendo que a primeira parcela será considerada vencida em/.test(f), f);
});

checa('2 faixas COM entrada — entrada some antes, faixas encadeadas depois', () => {
  const f = frasePagamento({ vencimento: '2026-10-10', entrada: { valor: 250, vencimento: '2026-09-10' }, faixas: [{ qtd: 3, valor: 300 }, { qtd: 12, valor: 400 }] });
  assert.ok(/^mediante o pagamento de uma entrada de <strong>R\$ 250,00/.test(f), f);
  assert.ok(/e o remanescente em 3 \(três\) parcelas mensais e sucessivas no valor de <strong>R\$ 300,00[^<]*<\/strong> cada, seguidas de 12 \(doze\) parcelas mensais e sucessivas no valor de <strong>R\$ 400,00[^<]*<\/strong> cada, sendo que/.test(f), f);
});

checa('faixa ÚNICA no array não vira "seguidas de" — cai no caminho uniforme de sempre', () => {
  const comFaixa = frasePagamento({ parcelas: 5, valorParcela: 280, vencimento: '2026-10-10', faixas: [{ qtd: 5, valor: 280 }] });
  const semFaixa = frasePagamento({ parcelas: 5, valorParcela: 280, vencimento: '2026-10-10' });
  assert.strictEqual(comFaixa, semFaixa, 'faixas:[um item] deveria dar a MESMA frase que não ter faixas');
  assert.ok(!/seguidas de/.test(comFaixa), comFaixa);
});

checa('faixa com qtd/valor zerado é ignorada (linha vazia do formulário não quebra a frase)', () => {
  const f = frasePagamento({ vencimento: '2026-10-10', faixas: [{ qtd: 3, valor: 300 }, { qtd: 0, valor: 0 }, { qtd: 12, valor: 400 }] });
  assert.ok(/3 \(três\).*seguidas de 12 \(doze\)/.test(f), f);
});

console.log(falhas ? `\nF-28 FALHOU — ${falhas} checagem(ns).\n` : '\nF-28 ok — faixas descritas no texto do acordo, frase de sempre intacta.\n');
process.exitCode = falhas ? 1 : 0;
