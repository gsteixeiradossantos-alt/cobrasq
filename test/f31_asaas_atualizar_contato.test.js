/*
 * Teste F-31 (Asaas) — a ação asaas-atualizar-contato corrige telefone JÁ preenchido,
 * que é justamente o que sincronizarCustomer não faz.
 *
 * Contexto (09/09/2026): o cadastro do Robson Ribeiro da Silva tinha o número de outra
 * pessoa. A régua mandou para lá 4 blocos em 07/09 e 4 em 09/09, com nome, valor e link
 * do boleto, até o terceiro responder pedindo que fosse para o número particular dele.
 * `contatoFaltante` (api/_asaas.js) só preenche buraco — com um número errado no lugar,
 * não há buraco e nada corrige. E corrigir só no Supabase não dura: bia-cobranca-sync
 * reescreve bia_cobranca.telefone a cada 30 min a partir do mobilePhone do Asaas.
 *
 * Como rodar:
 *   node test/f31_asaas_atualizar_contato.test.js
 */
'use strict';

const path = require('path');
const assert = require('assert');
const Module = require('module');

process.env.ASAAS_API_KEY = 'chave-teste';
process.env.ASAAS_ENV = 'sandbox';
process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon-teste';

const RAIZ = path.join(__dirname, '..');
const alvo = path.join(RAIZ, 'api', '_asaas-atualizar-contato.js');

// Stubs de auth/banco: o teste é sobre a regra de contato, não sobre login.
let papelAtual = 'proprietario';
const originalLoad = Module._load;
Module._load = function (pedido, pai, ehMain) {
  if (pedido === './_auth.js') {
    return { applyCors() {}, requireUser: async () => ({ id: 'user-teste' }) };
  }
  if (pedido === './_sb.js') {
    return { sbFetch: async () => [{ papel: papelAtual }] };
  }
  return originalLoad(pedido, pai, ehMain);
};
const handler = require(alvo);
Module._load = originalLoad;

// Customer fake do Asaas, com o telefone ERRADO já preenchido.
let customer = { id: 'cus_1', name: 'Robson Ribeiro da Silva', mobilePhone: '46999189842', phone: null, email: null };
let puts = [];
global.fetch = async (url, opts) => {
  const metodo = (opts && opts.method) || 'GET';
  if (metodo === 'PUT') {
    const corpo = JSON.parse(opts.body);
    puts.push(corpo);
    customer = { ...customer, ...corpo };
    return { ok: true, status: 200, text: async () => JSON.stringify(customer) };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(customer) };
};

function resposta() {
  const r = { code: 0, corpo: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (o) => { r.corpo = o; return r; };
  r.end = () => r;
  r.setHeader = () => {};
  return r;
}
const chamar = async (body, query) => {
  const res = resposta();
  await handler({ method: 'POST', headers: {}, body, query: query || {} }, res);
  return res;
};

let falhas = 0;
async function checa(nome, fn) {
  try { await fn(); console.log('  ok   ' + nome); }
  catch (e) { falhas++; console.log('  FALHA ' + nome + '\n        ' + e.message); }
}

(async () => {
  console.log('F-31 · Asaas: corrigir contato de customer');

  await checa('sobrescreve telefone JÁ preenchido (o que contatoFaltante não faz)', async () => {
    puts = [];
    const r = await chamar({ customerId: 'cus_1', mobilePhone: '46999361140' });
    assert.strictEqual(r.code, 200, JSON.stringify(r.corpo));
    assert.strictEqual(r.corpo.alterado, true);
    assert.strictEqual(r.corpo.antes.mobilePhone, '46999189842');
    assert.strictEqual(r.corpo.depois.mobilePhone, '46999361140');
    assert.deepStrictEqual(puts, [{ mobilePhone: '46999361140' }], 'deve mandar só o campo alterado');
  });

  await checa('aceita número com DDI e grava no formato do Asaas', async () => {
    customer = { id: 'cus_1', name: 'Teste', mobilePhone: '46999189842', phone: null, email: null };
    puts = [];
    await chamar({ customerId: 'cus_1', mobilePhone: '+55 (46) 99936-1140' });
    assert.deepStrictEqual(puts, [{ mobilePhone: '46999361140' }]);
  });

  await checa('idempotente: mesmo número não gera PUT', async () => {
    customer = { id: 'cus_1', name: 'Teste', mobilePhone: '46999361140', phone: null, email: null };
    puts = [];
    const r = await chamar({ customerId: 'cus_1', mobilePhone: '46999361140' });
    assert.strictEqual(r.corpo.alterado, false);
    assert.strictEqual(puts.length, 0);
  });

  await checa('dry-run mostra o antes/depois sem gravar', async () => {
    customer = { id: 'cus_1', name: 'Teste', mobilePhone: '46999189842', phone: null, email: null };
    puts = [];
    const r = await chamar({ customerId: 'cus_1', mobilePhone: '46999361140' }, { dry: '1' });
    assert.strictEqual(r.corpo.dry, true);
    assert.deepStrictEqual(r.corpo.seria_gravado, { mobilePhone: '46999361140' });
    assert.strictEqual(puts.length, 0, 'dry-run não pode gravar');
  });

  await checa('recusa telefone inválido', async () => {
    const r = await chamar({ customerId: 'cus_1', mobilePhone: '123' });
    assert.strictEqual(r.code, 400);
  });

  await checa('só proprietário altera contato', async () => {
    papelAtual = 'colaborador';
    const r = await chamar({ customerId: 'cus_1', mobilePhone: '46999361140' });
    papelAtual = 'proprietario';
    assert.strictEqual(r.code, 403);
  });

  // A ação nova entra como arquivo "_"-prefixado despachado pelo automacao.js — se
  // virasse api/asaas-atualizar-contato.js contaria no limite de 12 do plano Hobby e o
  // build quebraria com o erro escondido no meio dos warnings.
  await checa('registrada no roteador e sem custo no limite da Vercel', async () => {
    const fs = require('fs');
    const rot = fs.readFileSync(path.join(RAIZ, 'api', 'automacao.js'), 'utf8');
    assert.ok(/'asaas-atualizar-contato':\s*require\('\.\/_asaas-atualizar-contato\.js'\)/.test(rot),
      'ação não registrada em api/automacao.js');
    assert.ok(fs.existsSync(path.join(RAIZ, 'api', '_asaas-atualizar-contato.js')));
    assert.ok(!fs.existsSync(path.join(RAIZ, 'api', 'asaas-atualizar-contato.js')),
      'arquivo sem "_" contaria no limite de 12 funções');
  });

  if (falhas) { console.log('\n' + falhas + ' falha(s)'); process.exit(1); }
  console.log('\nF-31 ok — telefone errado é corrigido, dry-run não grava, e só o proprietário roda.');
})();
