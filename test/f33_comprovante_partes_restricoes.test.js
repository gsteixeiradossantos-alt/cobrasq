/*
 * Teste F-33 (api/_repasse-msg.js) — mensagem do comprovante de repasse ao credor:
 *   1. nomeia TODAS as partes da cobrança, cada uma com seu documento
 *      (11/09/2026: repasse da Imobiliária Casaril saiu só com "Elaine Baranoski",
 *      quando a cobrança é dela e de Sidimar Pruch);
 *   2. só na 1ª parcela (ou pagamento único) leva o pedido de baixa de restrições
 *      (SPC/SERASA/Boa Vista) e de carta de anuência em caso de protesto;
 *   3. fecha com "Qualquer dúvida é só nos comunicar!";
 *   4. (12/09/2026) sem "(s)/(es)" nem "n.": o parágrafo de restrições nomeia cada
 *      parte ("no nome de A ou de B"), 1/1 vira "pagamento à vista" e as demais
 *      "parcela N de M do acordo firmado por" — texto fechado pelo Gustavo.
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

const { msgComprovanteCredor, listarPagadores, pedeBaixaRestricoes, PARAGRAFO_RESTRICOES, paragrafoRestricoes } = require('../api/_repasse-msg.js');

const ELAINE = { nome: 'Elaine Baranoski', doc: '105.321.999-79', principal: true };
const SIDIMAR = { nome: 'Sidimar Pruch', doc: '01234567890', principal: false };

// 1. Duas partes, parcela 1 de 6 → as duas na frase, cada uma com o documento por
//    extenso; restrições "no nome de A ou de B".
{
  const m = msgComprovanteCredor({ parcela: 1, total: 6, devedor: 'Elaine Baranoski', doc: '105.321.999-79', partes: [ELAINE, SIDIMAR] });
  assert.ok(m.includes('referente à *parcela 1 de 6* do acordo firmado por *Elaine Baranoski (CPF n. 105.321.999-79) e Sidimar Pruch (CPF n. 012.345.678-90).*'), m);
  assert.ok(m.includes('Se houver restrição no nome de Elaine Baranoski ou de Sidimar Pruch em SPC, SERASA, Boa Vista/CDL e afins, solicitamos a retirada com urgência. Havendo protesto, pedimos o envio da carta de anuência em formato eletrônico.'), m);
  assert.ok(!/\(s\)|\(es\)|parcela n\./.test(m), 'sem (s)/(es)/n.: ' + m);
}

// 2. Três partes → "A, B e C" na frase; "A ou de B ou de C" nas restrições.
assert.strictEqual(
  listarPagadores([{ nome: 'A', doc: '' }, { nome: 'B', doc: '' }, { nome: 'C', doc: '' }]),
  'A, B e C'
);
assert.strictEqual(paragrafoRestricoes(['A', 'B', 'C']).startsWith('Se houver restrição no nome de A ou de B ou de C em SPC'), true);

// 3. Pagamento à vista (1 de 1), uma devedora — caso Jéssica Milanez, 12/09/2026.
{
  const m = msgComprovanteCredor({ parcela: 1, total: 1, devedor: 'Jessica Maikot Milanez', doc: '091.133.699-03', partes: [{ nome: 'Jessica Maikot Milanez', doc: '09113369903', principal: true }] });
  assert.ok(m.includes('o comprovante de repasse do pagamento à vista realizado por *Jessica Maikot Milanez (CPF n. 091.133.699-03).*'), m);
  assert.ok(m.includes('Se houver restrição no nome de Jessica Maikot Milanez em SPC'), m);
  assert.ok(!m.includes('parcela'), m);
}
// 3b. Sem número de parcela (repasse antigo do Controlle) → também à vista.
{
  const m = msgComprovanteCredor({ parcela: null, devedor: 'X', partes: [] });
  assert.ok(m.includes('do pagamento à vista realizado por *X.*'), m);
}

// 4. Sem partes → cai no par devedor/doc (repasse importado do Controlle); parcela 3 de 8.
{
  const m = msgComprovanteCredor({ parcela: 3, total: 8, devedor: 'Fulana', doc: '22.730.701/0001-19', partes: [] });
  assert.ok(m.includes('referente à *parcela 3 de 8* do acordo firmado por *Fulana (CNPJ n. 22.730.701/0001-19).*'), m);
}
// 4b. Parcela sem total conhecido → "parcela 3", sem inventar o total.
{
  const m = msgComprovanteCredor({ parcela: 3, total: null, devedor: 'Fulana', partes: [] });
  assert.ok(m.includes('referente à *parcela 3* do acordo firmado por *Fulana.*'), m);
}

// 5. Parágrafo de restrições: só na 1ª parcela ou pagamento único; nunca da 2ª em diante.
assert.strictEqual(pedeBaixaRestricoes(1), true);
assert.strictEqual(pedeBaixaRestricoes('1'), true);
assert.strictEqual(pedeBaixaRestricoes(null), true);
assert.strictEqual(pedeBaixaRestricoes(2), false);
assert.strictEqual(pedeBaixaRestricoes(5), false);
{
  const p1 = msgComprovanteCredor({ parcela: 1, total: 4, devedor: 'X', partes: [] });
  const p2 = msgComprovanteCredor({ parcela: 2, total: 4, devedor: 'X', partes: [] });
  const avista = msgComprovanteCredor({ parcela: null, devedor: 'X', partes: [] });
  assert.ok(p1.includes(PARAGRAFO_RESTRICOES), p1);
  assert.ok(avista.includes(PARAGRAFO_RESTRICOES), avista);
  assert.ok(!p2.includes(PARAGRAFO_RESTRICOES), p2);
  assert.ok(!p2.includes('Se houver restrição'), p2);
  assert.ok(PARAGRAFO_RESTRICOES.includes('SPC, SERASA, Boa Vista/CDL'));
  assert.ok(PARAGRAFO_RESTRICOES.includes('carta de anuência'));
}

// 6. Fechamento, e o antigo não volta.
{
  const m = msgComprovanteCredor({ parcela: 3, total: 5, devedor: 'X', partes: [] });
  assert.ok(m.startsWith('*Setor financeiro | COBRASQ:*\n'), m);
  assert.ok(m.includes('Qualquer dúvida é só nos comunicar!'), m);
  assert.ok(!m.includes('Ficamos à disposição'), m);
  assert.ok(m.endsWith('*COBRASQ Recuperadora de Crédito e Cobrança*'), m);
}

// 7. Sem devedor nenhum (descrição da ponte de recebimento): sem "por", e as
//    restrições caem em "no nome de quem pagou".
{
  const m = msgComprovanteCredor({ parcela: 2, total: 3, devedor: '', partes: [] });
  assert.ok(m.includes('comprovante de repasse referente à *parcela 2 de 3*.'), m);
  assert.ok(!m.includes(' por '), m);
  const m1 = msgComprovanteCredor({ parcela: 1, total: 3, devedor: '', partes: [] });
  assert.ok(m1.includes('Se houver restrição no nome de quem pagou em SPC'), m1);
}

console.log('F-33 ok — comprovante nomeia todas as partes, sem (s)/(es), à vista × parcela N de M, restrições só na 1ª parcela');
