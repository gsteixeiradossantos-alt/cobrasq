/*
 * Teste F-33 (api/_repasse-msg.js) — mensagem do comprovante de repasse ao credor:
 *   1. nomeia TODAS as partes da cobrança, cada uma com seu documento
 *      (11/09/2026: repasse da Imobiliária Casaril saiu só com "Elaine Baranoski",
 *      quando a cobrança é dela e de Sidimar Pruch);
 *   2. só na 1ª parcela (ou pagamento único) leva o pedido de baixa de restrições
 *      (SPC/SERASA/Boa Vista) e de carta de anuência em caso de protesto;
 *   3. fecha com "Qualquer dúvida é só nos comunicar!".
 *
 * Como rodar:
 *   node test/f33_comprovante_partes_restricoes.test.js
 */
'use strict';

const assert = require('assert');

process.env.SUPABASE_URL = 'https://sb.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.ZAPI_TOKEN = 't';
process.env.ZAPI_INSTANCE_ID = 'i';

const { msgComprovanteCredor, listarPagadores, pedeBaixaRestricoes, PARAGRAFO_RESTRICOES } = require('../api/_repasse-msg.js');

const ELAINE = { nome: 'Elaine Baranoski', doc: '105.321.999-79', principal: true };
const SIDIMAR = { nome: 'Sidimar Pruch', doc: '01234567890', principal: false };

// 1. Duas partes → as duas na frase, cada uma com o documento por extenso.
{
  const m = msgComprovanteCredor({ parcela: 1, devedor: 'Elaine Baranoski', doc: '105.321.999-79', partes: [ELAINE, SIDIMAR] });
  assert.ok(m.includes('*Elaine Baranoski (CPF n. 105.321.999-79) e Sidimar Pruch (CPF n. 012.345.678-90).*'), m);
  assert.ok(m.includes('referente à *parcela n. 1* do pagamento realizado por'), m);
}

// 2. Três partes → "A, B e C".
assert.strictEqual(
  listarPagadores([{ nome: 'A', doc: '' }, { nome: 'B', doc: '' }, { nome: 'C', doc: '' }]),
  'A, B e C'
);

// 3. Sem partes → cai no par devedor/doc de antes (repasse importado do Controlle).
{
  const m = msgComprovanteCredor({ parcela: 2, devedor: 'Fulana', doc: '22.730.701/0001-19', partes: [] });
  assert.ok(m.includes('*Fulana (CNPJ n. 22.730.701/0001-19).*'), m);
}

// 4. Parágrafo de restrições: só na 1ª parcela ou pagamento único; nunca da 2ª em diante.
assert.strictEqual(pedeBaixaRestricoes(1), true);
assert.strictEqual(pedeBaixaRestricoes('1'), true);
assert.strictEqual(pedeBaixaRestricoes(null), true);
assert.strictEqual(pedeBaixaRestricoes(2), false);
assert.strictEqual(pedeBaixaRestricoes(5), false);
{
  const p1 = msgComprovanteCredor({ parcela: 1, devedor: 'X', partes: [] });
  const p2 = msgComprovanteCredor({ parcela: 2, devedor: 'X', partes: [] });
  const avista = msgComprovanteCredor({ parcela: null, devedor: 'X', partes: [] });
  assert.ok(p1.includes(PARAGRAFO_RESTRICOES), p1);
  assert.ok(avista.includes(PARAGRAFO_RESTRICOES), avista);
  assert.ok(!p2.includes(PARAGRAFO_RESTRICOES), p2);
  assert.ok(PARAGRAFO_RESTRICOES.includes('SPC, SERASA, Boa Vista/CDL'));
  assert.ok(PARAGRAFO_RESTRICOES.includes('carta de anuência'));
}

// 5. Fechamento novo, e o antigo não volta.
{
  const m = msgComprovanteCredor({ parcela: 3, devedor: 'X', partes: [] });
  assert.ok(m.includes('Qualquer dúvida é só nos comunicar!'), m);
  assert.ok(!m.includes('Ficamos à disposição'), m);
  assert.ok(m.endsWith('*COBRASQ Recuperadora de Crédito e Cobrança*'), m);
}

// 6. Sem devedor nenhum (descrição da ponte de recebimento): sem "realizado por".
{
  const m = msgComprovanteCredor({ parcela: 2, devedor: '', partes: [] });
  assert.ok(m.includes('comprovante de repasse referente à *parcela n. 2*.'), m);
  assert.ok(!m.includes('realizado por'), m);
}

console.log('F-33 ok — comprovante nomeia todas as partes, restrições só na 1ª parcela, fechamento novo');
