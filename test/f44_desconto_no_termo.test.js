/*
 * Teste F-44 — desconto concedido na cláusula 1 dos termos de acordo.
 *
 * O caso: em 22/09/2026 só o termo de QUITAÇÃO JÁ PAGA sabia dizer de quanto
 * era a dívida atualizada e que o acordo é abatimento por liberalidade. No
 * termo judicial e no extrajudicial — inclusive na quitação ainda a pagar, que
 * é gerada pelo judicial com uma parcela só — a cláusula 1 dizia apenas o valor
 * do acordo, e o desconto sumia do documento.
 *
 * Este teste trava a redação nova nos dois termos, com e sem o valor atualizado
 * informado, e a existência dos campos no painel.
 *
 * Como rodar:
 *   node test/f44_desconto_no_termo.test.js
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
function checa(nome, fn) {
  try { fn(); console.log('  ok   ' + nome); }
  catch (e) { falhas++; console.log('  FALHA ' + nome + '\n        ' + e.message); }
}
const texto = html => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function dados(extra) {
  return {
    credor: { nome: 'COBRASQ Recuperadora de Crédito e Cobrança Ltda', genero: 'F', qualificacao: 'pessoa jurídica de direito privado, inscrita no CNPJ sob n. 34.626.848/0001-42.', assNome: 'COBRASQ', assDoc: 'CNPJ 34.626.848/0001-42' },
    devedores: [{ nome: 'Deivid Ghizzo', tipo: 'PF', genero: 'M', documento: '096.359.249-17', endereco: {}, telefone: '(46) 9981-2776' }],
    judicial: { numeroProcesso: '0002050-74.2022.8.16.0141', comarca: 'Realeza', juizado: true, rito: 'execucao' },
    dataAcordo: '2026-09-22',
    acordo: Object.assign({ total: 4250, vencimento: '2026-10-22', faixas: [{ qtd: 1, valor: 4250 }], multa: 10, penal: 50 }, extra || {})
  };
}
const COM = { valorAtualizado: 4823.49, dataAtualizacao: '2026-09-22' };

console.log('F-44 — desconto na cláusula 1 dos termos');

(async () => {
  const judCom = texto(await E.montarTermoJudicial(dados(COM)));
  const judSem = texto(await E.montarTermoJudicial(dados()));
  const extCom = texto(await E.montarTermoExtrajudicial(dados(COM)));
  const extSem = texto(await E.montarTermoExtrajudicial(dados()));

  checa('judicial: dívida atualizada, data e valor do acordo na cláusula 1', () => {
    assert.ok(/O valor atual do presente feito está atualizado em R\$ 4\.823,49 \(quatro mil, oitocentos e vinte e três reais e quarenta e nove centavos\) para 22 de setembro de 2026/.test(judCom), 'frase da dívida atualizada não saiu');
    assert.ok(/do qual a parte executada reconhece, de forma expressa, a existência, liquidez e exigibilidade/.test(judCom), 'reconhecimento não concordou com a parte');
    assert.ok(/por mera liberalidade das partes, essas acordaram o pagamento do valor para quitação total do débito, no valor total de R\$ 4\.250,00 \(quatro mil, duzentos e cinquenta reais\)/.test(judCom), 'abatimento por liberalidade não saiu');
  });

  checa('extrajudicial: mesma frase, falando do instrumento e da parte devedora', () => {
    assert.ok(/O valor atual do presente débito está atualizado em R\$ 4\.823,49 \(quatro mil, oitocentos e vinte e três reais e quarenta e nove centavos\) para 22 de setembro de 2026/.test(extCom), 'frase da dívida atualizada não saiu');
    assert.ok(/do qual a parte devedora reconhece[\s\S]{0,120}descrito neste instrumento/.test(extCom), 'não falou do instrumento/parte devedora');
    assert.ok(/no valor total de R\$ 4\.250,00 \(quatro mil, duzentos e cinquenta reais\)/.test(extCom), 'valor do acordo não saiu');
  });

  checa('sem valor atualizado, a cláusula 1 volta à redação de sempre', () => {
    assert.ok(!/está atualizado em/.test(judSem) && !/está atualizado em/.test(extSem), 'frase do desconto vazou sem dado informado');
    assert.ok(/A parte executada reconhece[\s\S]{0,200}consolidação integral do débito até a presente data/.test(judSem), 'redação antiga do judicial se perdeu');
    assert.ok(/A parte devedora reconhece[\s\S]{0,200}consolidação do montante devido até a data da assinatura/.test(extSem), 'redação antiga do extrajudicial se perdeu');
  });

  checa('nenhum token por preencher nos quatro termos', () => {
    for (const [nome, t] of [['jud/com', judCom], ['jud/sem', judSem], ['ext/com', extCom], ['ext/sem', extSem]]) {
      const m = t.match(/\{\{\w+\}\}/g);
      assert.ok(!m, nome + ' deixou token: ' + (m || []).join(', '));
    }
  });

  checa('quitação já paga continua lendo o valor atualizado do acordo', async () => {
    assert.ok(/está atualizado em R\$ 4\.823,49/.test(E.fraseReconhecimento(dados(COM))), 'quitação parou de ver acordo.valorAtualizado');
  });

  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  checa('painel: campos do desconto fora do bloco de quitação e ligados ao acordo', () => {
    assert.ok(/id="tajDescFields"/.test(idx), 'bloco tajDescFields não existe');
    const bloco = idx.slice(idx.indexOf('id="tajDescFields"'), idx.indexOf('id="tajDescFields"') + 1200);
    assert.ok(/tajQuitValorAtual/.test(bloco) && /tajQuitDataAtual/.test(bloco), 'os dois campos não estão no bloco do desconto');
    assert.ok(/valorAtualizado:num\('tajQuitValorAtual'\), dataAtualizacao:v\('tajQuitDataAtual'\)/.test(idx), 'dados do acordo não levam o valor atualizado');
  });

  console.log(falhas ? '\nF-44 FALHOU (' + falhas + ')' : '\nF-44 ok — o desconto aparece no termo.');
  process.exit(falhas ? 1 : 0);
})();
