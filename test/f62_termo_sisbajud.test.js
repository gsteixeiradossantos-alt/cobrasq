/*
 * Teste F-62 — termo de acordo judicial, cláusula 4 no modo Sisbajud.
 *
 * O caso: modelo de acordo do processo 0003337-57.2025.8.16.0209 (aprovado pelo
 * Gustavo em 07/10/2026). Três ajustes no termo judicial com Sisbajud:
 *   1. o aditivo em 5 dias vale para bloqueio MAIOR ou MENOR que o informado
 *      (antes: só "em montante superior");
 *   2. com valor levantado pela parte credora, os requerimentos finais pedem a
 *      transferência/alvará desse valor (e a liberação ao devedor, se houver);
 *   3. com valor levantado pela parte credora, a cláusula 2 vira alíneas:
 *      a) o Sisbajud; b) o saldo nas faixas do sistema (nº, valor, 1º e último
 *      vencimento). a) + b) tem de fechar com o total digitado
 *      (clausula4.totalAcordo); se não fechar, o motor lança erro — nada de
 *      termo com conta errada.
 * Sem Sisbajud (ou Sisbajud sem valor à parte credora), cláusula 2 e
 * requerimentos ficam idênticos ao texto de antes.
 *
 * Como rodar:
 *   node test/f62_termo_sisbajud.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

globalThis.fetch = async function (url) {
  const rel = String(url).replace(/^\//, '');
  const file = path.join(__dirname, '..', rel);
  const ok = fs.existsSync(file);
  return { ok, status: ok ? 200 : 404, text: async () => fs.readFileSync(file, 'utf8') };
};
require(path.join(__dirname, '..', 'templates', 'termo-engine.js'));
const E = globalThis.TermoEngine;

let falhas = 0;
async function checa(nome, fn) {
  try { await fn(); console.log('  ok   ' + nome); }
  catch (e) { falhas++; console.log('  FALHA ' + nome + '\n        ' + e.message); }
}
const texto = html => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
// corpo (HTML) de uma cláusula pelo título
function clausula(html, titulo) {
  const re = new RegExp('<h2 class="clause-title">' + titulo + '[\\s\\S]*?<div class="clause-body">([\\s\\S]*?)</div>\\s*</article>');
  const m = html.match(re);
  if (!m) throw new Error('cláusula "' + titulo + '" não encontrada');
  return m[1];
}

function dados(c4, extra) {
  return Object.assign({
    tipo: 'judicial',
    credor: { nome: 'COBRASQ Recuperadora de Crédito e Cobrança Ltda', genero: 'F', qualificacao: 'pessoa jurídica, CNPJ 34.626.848/0001-42, com sede em Dois Vizinhos, Estado do Paraná', assNome: 'COBRASQ', assDoc: 'CNPJ 34.626.848/0001-42' },
    devedores: [{ nome: 'Maria da Silva', tipo: 'PF', genero: 'F', documento: '000.000.000-00', endereco: { rua: 'Rua A', numero: '1', bairro: 'Centro', cidade: 'Dois Vizinhos', uf: 'PR', cep: '85660-000' }, telefone: '(46) 99999-0000' }],
    // faixas = SALDO (10 × R$ 150,00 = R$ 1.500,00)
    acordo: { total: 1500, parcelas: 10, valorParcela: 150, vencimento: '2026-11-10', multa: 10, penal: 50, faixas: [{ qtd: 10, valor: 150 }] },
    judicial: { numeroProcesso: '0003337-57.2025.8.16.0209', comarca: 'Dois Vizinhos', foro: 'jec', clausula4: c4 },
  }, extra || {});
}
const SIS = { mode: 'sisbajud', valorBloqueado: 1234.56, levExequente: 1000, levExecutado: 234.56, totalAcordo: 2500,
  contaExecutado: { pix: '000.000.000-00', titular: 'Maria da Silva' } };

(async function () {
  console.log('\nF-62 · termo judicial: cláusula 4 Sisbajud (aditivo, requerimentos, forma de pagamento)\n');

  const sem = await E.montarTermoJudicial(dados({ mode: '' }));
  const com = await E.montarTermoJudicial(dados(SIS));
  const semLev = await E.montarTermoJudicial(dados({ mode: 'sisbajud', valorBloqueado: 500, levExecutado: 500 }));
  const tCom = texto(com);

  await checa('1. aditivo vale para bloqueio maior OU menor (sem "montante superior")', () => {
    const c4 = texto(clausula(com, 'Do <em>Sisbajud</em>'));
    assert.ok(/seja maior ou menor que o descrito nesta cláusula, as partes protocolarão termo aditivo no prazo de 5 \(cinco\) dias, ajustando os valores e a forma de pagamento/.test(c4), c4);
    assert.ok(!/montante superior/.test(tCom));
    assert.ok(/maior ou menor/.test(texto(semLev)), 'sem levantamento ao exequente o aditivo também é o novo');
  });

  await checa('Sisbajud sempre em itálico (título, cláusula 4, cláusula 2, requerimentos)', () => {
    assert.ok(!/Sistema Sisbajud/.test(com));
    const soltos = com.replace(/<em>Sisbajud<\/em>/g, '').match(/Sisbajud/g) || [];
    // as únicas ocorrências fora de <em> são o CSS/comentários do template
    const corpo = com.slice(com.indexOf('<section class="clauses">'));
    assert.strictEqual((corpo.replace(/<em>Sisbajud<\/em>/g, '').match(/Sisbajud/g) || []).length, 0, soltos.length + ' soltos');
  });

  await checa('3. cláusula 2 em alíneas: a) Sisbajud, b) saldo com nº, valor, 1º e último vencimento', () => {
    const c2 = texto(clausula(com, 'Da forma de pagamento'));
    assert.ok(/valor total da dívida, ou seja, de R\$ 2\.500,00 \(dois mil e quinhentos reais\) , será realizado da seguinte forma:/.test(c2), c2);
    assert.ok(/a\) R\$ 1\.000,00 \(mil reais\) , mediante o levantamento, em favor da parte exequente, do valor bloqueado por meio do sistema Sisbajud nestes autos, para a conta indicada na cláusula 4; e/.test(c2), c2);
    assert.ok(/b\) o saldo de R\$ 1\.500,00 \(mil e quinhentos reais\) , mediante o pagamento de 10 \(dez\) parcelas mensais e sucessivas no valor de R\$ 150,00/.test(c2), c2);
    assert.ok(/primeira parcela será considerada vencida em 10 de novembro de 2026 , e a última em 10 de agosto de 2027 , prorrogando-se/.test(c2), c2);
  });

  await checa('cláusula 1 cita o total do acordo (Sisbajud + saldo), não só as parcelas', () => {
    assert.ok(/R\$ 2\.500,00/.test(texto(clausula(com, 'Valor, reconhecimento'))));
  });

  await checa('2. requerimentos pedem transferência/alvará ao exequente e liberação ao executado', () => {
    const r = texto(clausula(com, 'Requerimentos'));
    assert.ok(/efeitos legais, a transferência do valor de R\$ 1\.000,00 \(mil reais\) , bloqueado por meio do sistema Sisbajud , para a conta da parte exequente indicada na cláusula 4, ou a expedição do respectivo alvará em seu favor, a liberação do valor de R\$ 234,56 .* em favor da parte executada, para a conta indicada na mesma cláusula, bem como, se houver audiência/.test(r), r);
  });

  await checa('2. sem valor ao executado: só o pedido ao exequente', async () => {
    const h = await E.montarTermoJudicial(dados(Object.assign({}, SIS, { levExecutado: 0, totalAcordo: 2500 })));
    const r = texto(clausula(h, 'Requerimentos'));
    assert.ok(/alvará em seu favor, bem como, se houver audiência/.test(r), r);
    assert.ok(!/liberação do valor/.test(r));
  });

  await checa('3. a) + b) ≠ total → erro com a diferença (não gera)', async () => {
    await assert.rejects(E.montarTermoJudicial(dados(Object.assign({}, SIS, { totalAcordo: 2600 }))),
      e => /não fecha/.test(e.message) && /diferença de R\$ 100,00/.test(e.message));
    await assert.rejects(E.montarTermoJudicial(dados(Object.assign({}, SIS, { totalAcordo: 0 }))),
      e => /informe o valor total do acordo/.test(e.message));
    assert.throws(() => E.sisbajudPagamento(dados(Object.assign({}, SIS, { totalAcordo: 2499.99 }))), /diferença de R\$ 0,01/);
  });

  await checa('sem Sisbajud: cláusula 2 e requerimentos com o texto de sempre', () => {
    const c2 = texto(clausula(sem, 'Da forma de pagamento'));
    assert.ok(/^ O pagamento do valor total da dívida, ou seja, de R\$ 1\.500,00 \(mil e quinhentos reais\) , será realizado mediante o pagamento de 10 \(dez\) parcelas mensais e sucessivas no valor de R\$ 150,00 \(cento e cinquenta reais\) cada, sendo que a primeira parcela será considerada vencida em 10 de novembro de 2026 , prorrogando-se o vencimento para o primeiro dia útil seguinte caso recaia em dia não útil\. /.test(c2), c2);
    const r = texto(clausula(sem, 'Requerimentos')).trim();
    assert.strictEqual(r, 'Diante do exposto, as partes requerem a homologação do presente acordo por sentença, para que produza seus efeitos legais, bem como, se houver audiência designada, o seu cancelamento, a retirada do nome da parte executada junto aos cadastros de inadimplentes incluídos por meio do Sistema SerasaJud e, ao final, comprovada a quitação integral, a extinção do processo e a liberação das constrições, se existentes, além das providências de baixa de restrições, na forma ajustada.');
    assert.ok(!/Sisbajud/.test(texto(sem)));
  });

  await checa('Sisbajud sem valor à parte credora: cláusula 2 e requerimentos iguais ao sem Sisbajud', () => {
    assert.strictEqual(clausula(semLev, 'Da forma de pagamento'), clausula(sem, 'Da forma de pagamento'));
    assert.strictEqual(clausula(semLev, 'Requerimentos'), clausula(sem, 'Requerimentos'));
  });

  await checa('rito conhecimento: alíneas e requerimentos falam parte autora/requerida', async () => {
    const d = dados(SIS); d.judicial.rito = 'conhecimento';
    const t = texto(await E.montarTermoJudicial(d));
    assert.ok(/em favor da parte autora, do valor bloqueado/.test(t) && /para a conta da parte autora indicada na cláusula 4/.test(t) && /em favor da parte requerida, para a conta/.test(t));
    assert.ok(!/exequente|executad/.test(t));
  });

  await checa('texto novo: sem "nº", sem "respeitosamente", sem aspas retas', () => {
    const novo = texto(clausula(com, 'Da forma de pagamento') + clausula(com, 'Requerimentos') + clausula(com, 'Do <em>Sisbajud</em>'));
    assert.ok(!/nº|respeitosamente|"/.test(novo), novo);
  });

  await checa('quitação já paga ignora o Sisbajud (não lança erro)', async () => {
    const d = dados(Object.assign({}, SIS, { totalAcordo: 0 }), { tipo: 'quitacao' });
    d.acordo.quitacao = { dataPagamento: '2026-10-07' };
    await E.montarTermoQuitacao(d);
  });

  await checa('painel: campo "Valor total do acordo" no bloco Sisbajud, lido e conferido antes de gravar parcelas', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.ok(/id="tajJudTotalAcordo"/.test(src));
    assert.ok(/totalAcordo:num\('tajJudTotalAcordo'\)/.test(src));
    const g = src.slice(src.indexOf('async function tajGerarPreview'));
    const iConf = g.indexOf('TermoEngine.sisbajudPagamento(dados)');
    const iGrava = g.indexOf('_tajFecharAcordo(');
    assert.ok(iConf > 0 && iConf < iGrava, 'conferência tem de vir antes de _tajFecharAcordo');
  });

  if (falhas) { console.log('\nF-62 FALHOU (' + falhas + ')'); process.exit(1); }
  console.log('\nF-62 ok — Sisbajud: aditivo maior/menor, pedido de transferência, pagamento em alíneas conferido.');
})();
