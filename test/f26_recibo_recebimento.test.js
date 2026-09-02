/*
 * Teste F-26 — o recebimento confirmado vira operação, e o recibo acha o telefone.
 *
 * Trava as duas falhas que deixaram 8 pagamentos sem recibo entre 28/08 e 02/09/2026,
 * ambas silenciosas: nenhuma derrubou o webhook, nenhuma virou log, e a primeira notícia
 * veio de um devedor perguntando "paguei a última né?".
 *
 *   1. NULL em coluna NOT NULL. O #589 trocou o split capital/honorário por
 *      `const valorCapital = null`. `fin_operacao.valor_capital` e `valor_honorario` são
 *      NOT NULL com default 0 — e um NULL EXPLÍCITO no INSERT não usa o default. Todo
 *      recebimento passou a morrer com 23502, e como o recibo é montado DEPOIS do INSERT,
 *      na mesma função, ele nunca chegava a existir.
 *
 *   2. Vários telefones num campo só. 52 devedores têm "42999642631, 42988521878, ..."
 *      em devedores.telefone. O `replace(/\D/g,'')` colava tudo num número de 43 dígitos,
 *      que casava com o teste de id de grupo do WhatsApp e ia para a Z-API como grupo
 *      inexistente.
 *
 * Como rodar:
 *   node test/f26_recibo_recebimento.test.js
 */
'use strict';

const path = require('path');
const assert = require('assert');
const fs = require('fs');

process.env.ZAPI_TOKEN = 'tok-teste';
process.env.ZAPI_INSTANCE_ID = 'inst-teste';
process.env.ZAPI_CLIENT_TOKEN = 'client-teste';

const { normalizarTelefone } = require(path.join(__dirname, '..', 'api', '_zapi.js'));

let falhas = 0;
function checa(nome, fn) {
  try { fn(); console.log('  ok   ' + nome); }
  catch (e) { falhas++; console.log('  FALHA ' + nome + '\n        ' + e.message); }
}

console.log('\nF-26 · recebimento vira operação, e o recibo acha o telefone\n');

// ── 1. O split não pode ser NULL ────────────────────────────────────────────────
const fonte = fs.readFileSync(path.join(__dirname, '..', 'api', '_processar-recebimento.js'), 'utf8');

checa('valorCapital/valorHonorario não são NULL (violam NOT NULL em fin_operacao)', () => {
  assert.ok(!/const\s+valorCapital\s*=\s*null/.test(fonte),
    'valorCapital = null derruba o INSERT com 23502 e mata o recibo junto');
  assert.ok(!/const\s+valorHonorario\s*=\s*null/.test(fonte),
    'valorHonorario = null derruba o INSERT com 23502 e mata o recibo junto');
});

checa('… e continuam sendo gravados como número', () => {
  assert.ok(/const\s+valorCapital\s*=\s*0\s*;/.test(fonte), 'valorCapital deve ser 0');
  assert.ok(/const\s+valorHonorario\s*=\s*0\s*;/.test(fonte), 'valorHonorario deve ser 0');
});

checa('quem diz que não houve divisão é o status, não um NULL', () => {
  assert.ok(/repasseStatus\s*=\s*'nao_aplica'/.test(fonte));
  assert.ok(/divisao_automatica:\s*false/.test(fonte));
});

// ── 2. Telefone: lista, número solto, grupo ─────────────────────────────────────
checa('campo com VÁRIOS telefones usa o primeiro (caso Cecilia, 4 números)', () => {
  assert.strictEqual(
    normalizarTelefone('42999642631, 42988521878, 42988568804, 43991694283'),
    '5542999642631');
});

checa('… e não vira um número de 43 dígitos', () => {
  const r = normalizarTelefone('42999642631, 42988521878, 42988568804, 43991694283');
  assert.ok(r.length <= 13, 'saiu com ' + r.length + ' dígitos: ' + r);
});

checa('outros separadores de lista (; | barra | quebra de linha)', () => {
  assert.strictEqual(normalizarTelefone('46999414792; 4635361101'), '5546999414792');
  assert.strictEqual(normalizarTelefone('46999414792 / 4635361101'), '5546999414792');
  assert.strictEqual(normalizarTelefone('46999414792\n4635361101'), '5546999414792');
});

checa('número único formatado NÃO é quebrado pelo DDD (regressão possível do split)', () => {
  assert.strictEqual(normalizarTelefone('(46) 99941-4792'), '5546999414792');
  assert.strictEqual(normalizarTelefone('46 9 9941-4792'), '5546999414792');
});

checa('número que já tem DDI fica como está', () => {
  assert.strictEqual(normalizarTelefone('5546999414792'), '5546999414792');
});

checa('id de grupo do WhatsApp continua passando inteiro', () => {
  assert.strictEqual(normalizarTelefone('120363417597227442-group'), '120363417597227442-group');
  assert.strictEqual(normalizarTelefone('120363417597227442'), '120363417597227442');
});

checa('lixo sem número plausível não vira envio para o número errado', () => {
  assert.strictEqual(normalizarTelefone('sem telefone'), '');
  assert.strictEqual(normalizarTelefone('123'), '');
  assert.strictEqual(normalizarTelefone(''), '');
  assert.strictEqual(normalizarTelefone(null), '');
});

checa('o recibo lê o telefone pelo normalizador, não por replace(/\\D/g)', () => {
  assert.ok(/normalizarTelefone\(\(devedor && devedor\.telefone\)/.test(fonte),
    'devedores.telefone precisa passar por normalizarTelefone');
  assert.ok(!/String\(\(devedor && devedor\.telefone\) \|\| ''\)\.replace\(\/\\D\/g, ''\)/.test(fonte),
    'o replace direto volta a colar a lista de números');
});

// ── 3. O webhook precisa OLHAR o status HTTP ───────────────────────────────────
const wh = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'asaas-webhook', 'index.ts'), 'utf8');

checa('asaas-webhook não engole erro do processar-recebimento', () => {
  assert.ok(/if\s*\(!r\.ok\)/.test(wh),
    'sem checar r.ok, um 500 vira 200 pro Asaas e a falha some para sempre');
  assert.ok(/registrarFalhaProcessamento/.test(wh),
    'a falha precisa ir para a fila visível (asaas_pagamento_orfao)');
});

console.log('');
if (falhas) { console.log('F-26 FALHOU (' + falhas + ').'); process.exit(1); }
console.log('F-26 ok — recebimento vira operação, recibo acha o telefone, e a falha aparece.');
