/*
 * Teste F-63 — faixa do acordo paga no cartão de crédito (link do Mercado Pago).
 *
 * O caso: em 08/10/2026 o Gustavo instituiu o pagamento à vista no cartão, por
 * link do Mercado Pago gerado à mão (o devedor parcela com a operadora; a taxa
 * é da COBRASQ). A faixa ganha o meio 'cartao': o termo diz "à vista no cartão
 * de crédito" e a cláusula 2 explica o link e o parcelamento com a
 * administradora; a faixa não vira boleto no Asaas.
 *
 * Trava também que boleto e PIX saem IDÊNTICOS a antes.
 *
 * Como rodar:
 *   node test/f63_acordo_cartao.test.js
 */
'use strict';

const path = require('path');
const assert = require('assert');

require(path.join(__dirname, '..', 'templates', 'termo-engine.js'));
const { frasePagamento, fraseEntregaBoletos } = globalThis.TermoEngine;

let falhas = 0;
function checa(nome, fn) {
  try { fn(); console.log('  ok   ' + nome); }
  catch (e) { falhas++; console.log('  FALHA ' + nome + '\n        ' + e.message); }
}

const F_CARTAO = 'O pagamento no cartão de crédito será feito à vista, por link de pagamento enviado à parte devedora em até 1 dia útil após a assinatura deste instrumento, pelo canal indicado no preâmbulo. Eventual parcelamento no cartão é contratado pela parte devedora diretamente com a administradora do cartão, por sua conta, e não altera o valor nem o vencimento ajustados neste acordo.';
const INICIO_BOL = 'Os boletos serão enviados';
const INICIO_PIX = 'O pagamento das parcelas via PIX';

console.log('\nF-63 · faixa no cartão de crédito (link Mercado Pago)\n');

checa('1 faixa no cartão — frase de pagamento diz "à vista no cartão de crédito"', () => {
  const f = frasePagamento({ parcelas: 1, valorParcela: 10000, vencimento: '2026-10-10', faixas: [{ qtd: 1, valor: 10000, meio: 'cartao' }] });
  assert.strictEqual(f, 'mediante o pagamento de 1 (uma) parcela mensal no valor de <strong>R$ 10.000,00 (dez mil reais)</strong>, à vista no cartão de crédito, sendo que a primeira parcela será considerada vencida em <strong>10 de outubro de 2026</strong>');
});

checa('só cartão — cláusula 2 traz só a frase do cartão (sem boleto nem PIX)', () => {
  const t = fraseEntregaBoletos({ faixas: [{ qtd: 1, valor: 10000, meio: 'cartao' }] }, 'F');
  assert.strictEqual(t, F_CARTAO);
});

checa('entrada no cartão + boletos — boleto e depois cartão', () => {
  const t = fraseEntregaBoletos({ faixas: [{ qtd: 1, valor: 500, meio: 'cartao' }, { qtd: 9, valor: 300, meio: 'boleto' }] }, 'F');
  assert.ok(t.startsWith(INICIO_BOL), t);
  assert.ok(t.endsWith(F_CARTAO), t);
  assert.ok(!t.includes(INICIO_PIX), t);
});

checa('PIX + cartão — PIX e depois cartão, sem boleto', () => {
  const t = fraseEntregaBoletos({ pixChave: 'x@y.com', faixas: [{ qtd: 1, valor: 500, meio: 'pix' }, { qtd: 1, valor: 900, meio: 'cartao' }] }, 'F');
  assert.ok(t.startsWith(INICIO_PIX), t);
  assert.ok(t.endsWith(F_CARTAO), t);
  assert.ok(!t.includes(INICIO_BOL), t);
});

checa('sem cartão — boleto puro, PIX puro e PIX + boleto saem como antes', () => {
  const bol = fraseEntregaBoletos({ faixas: [{ qtd: 3, valor: 100, meio: 'boleto' }] }, 'F');
  assert.ok(bol.startsWith(INICIO_BOL) && !bol.includes(INICIO_PIX) && !bol.includes('cartão'), bol);
  const semFaixa = fraseEntregaBoletos({ parcelas: 3, valorParcela: 100 }, 'F');
  assert.strictEqual(semFaixa, bol);
  const pix = fraseEntregaBoletos({ pixChave: 'x@y.com', faixas: [{ qtd: 1, valor: 100, meio: 'pix' }] }, 'F');
  assert.ok(pix.startsWith(INICIO_PIX) && !pix.includes(INICIO_BOL), pix);
  const misto = fraseEntregaBoletos({ pixChave: 'x@y.com', faixas: [{ qtd: 1, valor: 100, meio: 'pix' }, { qtd: 2, valor: 50, meio: 'boleto' }] }, 'F');
  assert.strictEqual(misto, bol + ' ' + pix);
});

checa('termo judicial — usa "parte executada" na frase do cartão', () => {
  const t = fraseEntregaBoletos({ faixas: [{ qtd: 1, valor: 100, meio: 'cartao' }] }, 'F', 'execucao');
  assert.ok(t.includes('enviado à parte executada') && t.includes('pela parte executada diretamente'), t);
});

checa('_emitir-acordo.js — faixa cartão fica fora do Asaas, como PIX', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'api', '_emitir-acordo.js'), 'utf8');
  assert.ok(/const foraAsaas = \(b\) => b\.meio === 'pix' \|\| b\.meio === 'cartao';/.test(src));
  assert.ok(src.includes('blocosMeta.filter((b) => !foraAsaas(b))'));
  assert.ok(src.includes('if (foraAsaas(bloco)) continue;'));
});

console.log(falhas ? `\n${falhas} falha(s)\n` : '\ntodos ok\n');
process.exit(falhas ? 1 : 0);
