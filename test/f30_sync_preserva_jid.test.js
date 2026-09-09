/*
 * Teste F-30 (bia-cobranca-sync) — a sync do Asaas não desfaz a canonização do
 * telefone.
 *
 * Contexto: o Asaas guarda o celular COM o nono dígito; o WhatsApp conhece boa
 * parte dos contatos do Sul SEM ele. Discar o formato errado não dá erro — a
 * Z-API aceita, devolve zaapId, gravamos "enviada" — e a mensagem fica num ✓
 * único para sempre. Em 09/09/2026, 89 das 110 linhas de bia_cobranca estavam
 * assim (25 cobranças ativas), e o backfill gravou o JID que entrega.
 *
 * Só que a sync reescrevia `telefone` a cada rodada com o mobilePhone cru do
 * Asaas — o backfill duraria até o próximo cron. Agora ela só sobrescreve quando
 * o número REALMENTE mudou (últimos 8 dígitos diferentes); outro formato do
 * mesmo número preserva o que está salvo.
 *
 * Como rodar:
 *   node test/f30_sync_preserva_jid.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const RAIZ = path.join(__dirname, '..');
const { mesmoNumero } = require(path.join(RAIZ, 'api', '_telefone-jid.js'));

let falhas = 0;
function checa(nome, fn) {
  try { fn(); console.log('  ok   ' + nome); }
  catch (e) { falhas++; console.log('  FALHA ' + nome + '\n        ' + e.message); }
}

console.log('F-30 · sync do Asaas preserva o JID canônico');

checa('formatos do mesmo número são reconhecidos', () => {
  // com e sem o nono dígito
  assert.strictEqual(mesmoNumero('5546999054692', '554699054692'), true);
  // com e sem DDI
  assert.strictEqual(mesmoNumero('46999054692', '554699054692'), true);
  // com máscara
  assert.strictEqual(mesmoNumero('(46) 99905-4692', '554699054692'), true);
});

checa('número trocado NÃO é preservado', () => {
  assert.strictEqual(mesmoNumero('5546999054692', '5546999863666'), false);
  // vazio nunca casa: sem telefone salvo, o do Asaas vale
  assert.strictEqual(mesmoNumero('', '554699054692'), false);
  assert.strictEqual(mesmoNumero('123', '554699054692'), false);
});

// A regra só serve se a sync realmente a usar no update. Sem isto, o teste
// acima passaria com a sync voltando a gravar `c.tel` por cima.
checa('a sync aplica a regra no update da linha existente', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'supabase', 'functions', 'bia-cobranca-sync', 'index.ts'), 'utf8');
  const update = src.slice(src.indexOf("atualizadas.push("));
  const linha = update.slice(0, update.indexOf('}).eq('));
  assert.ok(/telefone:\s*telefonePreservado\(/.test(linha),
    'o update precisa passar por telefonePreservado(); achado: ' + linha.trim().slice(0, 200));
  assert.ok(/mesmoNumero\(/.test(src), 'telefonePreservado deve comparar com mesmoNumero()');
});

// As duas cópias do helper (Deno e Vercel) precisam concordar — o teste roda a
// versão JS, então a TS é a que pode divergir sem ninguém notar.
checa('as duas cópias do helper têm mesmoNumero', () => {
  const ts = fs.readFileSync(path.join(RAIZ, 'supabase', 'functions', '_shared', 'telefone-jid.ts'), 'utf8');
  assert.ok(/export function mesmoNumero/.test(ts), 'falta mesmoNumero em _shared/telefone-jid.ts');
  assert.ok(ts.includes("slice(-8)"), 'a comparação por 8 dígitos sumiu da versão Deno');
});

if (falhas) { console.log('\n' + falhas + ' falha(s)'); process.exit(1); }
console.log('\nF-30 ok — outro formato do mesmo número preserva o JID; número trocado atualiza.');
