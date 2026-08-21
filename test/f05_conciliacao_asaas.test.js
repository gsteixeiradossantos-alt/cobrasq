/*
 * Teste F-05 (conciliação Asaas) — escolherLancamento casa o pagamento com a parcela
 * certa nos casos que quebraram em produção.
 *
 * Roda contra o CÓDIGO REAL (api/_conciliacao-asaas.js), sem rede: a função de
 * escolha é pura e é extraída do módulo para não disparar os requires de auth/Asaas.
 *
 * Como rodar:
 *   node test/f05_conciliacao_asaas.test.js
 *
 * Contexto (levantamento de 21/08/2026): a casada antiga era "primeiro lançamento de
 * valor igual entre os 20 mais recentes por data de criação". Os casos abaixo são os
 * reais que ela errou, e cada um trava aqui:
 *   1. Marinalva — 20 parcelas futuras criadas depois empurraram a parcela a baixar
 *      para a posição 21: ela sumia da janela;
 *   2. Fatima — 20 parcelas JÁ PAGAS ocupavam a janela e escondiam a única aberta;
 *   3. Ivone — 26 parcelas de valor idêntico: sem o vencimento não há como escolher,
 *      e escolher errado quita a parcela errada;
 *   4. Sidimar — pagou 343,82 numa parcela de 312,00 (juros e multa): valor exato
 *      nunca casa;
 *   5. webhook reenviado — o Asaas reenvia até receber 200; sem o vínculo gravado,
 *      o reenvio baixava uma SEGUNDA parcela.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'api', '_conciliacao-asaas.js'), 'utf8');
const corpo = src.slice(src.indexOf('function round2'), src.indexOf('module.exports'));
const escolherLancamento = new Function(corpo + '; return escolherLancamento;')();

function caso(nome, lancamentos, pagamento, criterioEsperado, alvoEsperado) {
  const r = escolherLancamento(lancamentos, pagamento);
  const idReal = r.alvo ? r.alvo.id : null;
  assert.strictEqual(r.criterio, criterioEsperado, `${nome}: critério ${r.criterio} ≠ ${criterioEsperado}`);
  assert.strictEqual(idReal, alvoEsperado, `${nome}: alvo ${idReal} ≠ ${alvoEsperado}`);
  console.log(`  ok  ${nome} (${r.criterio}, confiança ${r.confianca})`);
  return r;
}

console.log('F-05 conciliação Asaas:');

// 1. Marinalva: a parcela certa está fora da janela de 20 mais recentes.
const marinalva = [
  { id: 'p5', valor: 375.18, status: 0, data_vencimento: '2026-08-15', asaas_payment_id: null },
  ...Array.from({ length: 20 }, (_, i) => ({
    id: 'fut' + i, valor: 338, status: 0,
    data_vencimento: '2026-09-10', asaas_payment_id: null,
  })),
];
caso('Marinalva — parcela fora da janela de 20', marinalva,
  { id: 'pay_A', value: 375.18, dueDate: '2026-08-15' }, 'vencimento', 'p5');

// 2. Fatima: 20 parcelas pagas ocupavam a janela; a única aberta ficava invisível.
const fatima = [
  ...Array.from({ length: 20 }, (_, i) => ({
    id: 'pago' + i, valor: 106, status: 1,
    data_vencimento: '2026-0' + (1 + (i % 9)) + '-15', asaas_payment_id: null,
  })),
  { id: 'f21', valor: 106, status: 0, data_vencimento: '2026-08-15', asaas_payment_id: null },
];
caso('Fatima — parcelas pagas não escondem a aberta', fatima,
  { id: 'pay_B', value: 106, dueDate: '2026-08-15' }, 'vencimento', 'f21');

// 3. Ivone: 26 parcelas idênticas. Com vencimento, casa exato.
const ivone = Array.from({ length: 26 }, (_, i) => ({
  id: 'iv' + i, valor: 506, status: 0,
  data_vencimento: `2026-${String(1 + (i % 12)).padStart(2, '0')}-24`,
  asaas_payment_id: null,
}));
caso('Ivone — 26 parcelas iguais, vencimento decide', ivone,
  { id: 'pay_C', value: 506, dueDate: ivone[4].data_vencimento }, 'vencimento', ivone[4].id);

// 3b. E SEM vencimento tem que se declarar ambíguo — nunca aplicar sozinho.
const amb = escolherLancamento(ivone, { id: 'pay_D', value: 506, dueDate: null });
assert.strictEqual(amb.criterio, 'valor_ambiguo');
assert.strictEqual(amb.confianca, 'baixa', 'ambíguo tem que sair com confiança baixa');
assert.ok(amb.empatados > 1, 'ambíguo tem que informar quantos empataram');
console.log(`  ok  Ivone sem vencimento — ambíguo, ${amb.empatados} empatados, confiança baixa`);

// 4. Sidimar: principal + juros/multa.
const sidimar = [{ id: 's4', valor: 312, status: 0, data_vencimento: '2026-08-25', asaas_payment_id: null }];
const acr = caso('Sidimar — valor mais acréscimo', sidimar,
  { id: 'pay_E', value: 343.82, dueDate: null }, 'valor_mais_acrescimo', 's4');
assert.strictEqual(acr.acrescimo, 31.82, 'o acréscimo tem que vir calculado para ir em juros');

// 5. Webhook reenviado: reconfirma o vínculo, não baixa a parcela seguinte.
const reenvio = [
  { id: 'v1', valor: 250, status: 1, data_vencimento: '2026-08-10', asaas_payment_id: 'pay_F' },
  { id: 'v2', valor: 250, status: 0, data_vencimento: '2026-09-10', asaas_payment_id: null },
];
caso('Webhook reenviado — reconfirma, não duplica', reenvio,
  { id: 'pay_F', value: 250, dueDate: '2026-08-10' }, 'ja_vinculado', 'v1');

// 6. Excedente absurdo (pagamento de outra coisa): não chuta parcela nenhuma.
caso('Excedente grande demais — sem candidato',
  [{ id: 'x1', valor: 100, status: 0, data_vencimento: '2026-08-01', asaas_payment_id: null }],
  { id: 'pay_G', value: 900, dueDate: null }, 'sem_candidato', null);

console.log('F-05: todos passaram.');
