/*
 * Teste F-43 — termo de acordo com QUITAÇÃO JÁ REALIZADA.
 *
 * O caso: até 22/09/2026 o painel só sabia gerar um termo judicial, o de
 * parcelamento. Quando o devedor JÁ pagou (caso Deivid Ghizzo, proc.
 * 0002050-74.2022.8.16.0141, R$ 4.250,00 por Pix em 22/09/2026), o termo saía
 * com encargos por atraso, vencimento antecipado, cláusula penal, custódia dos
 * títulos em garantia e manutenção das penhoras — tudo sobre dívida que não
 * existe mais —, e as três validações de tajGerarPreview ainda exigiam faixa de
 * parcelas e 1º vencimento.
 *
 * Este teste trava o modelo novo: cláusulas de quitação (liberação das penhoras,
 * arts. 924, II e 925 do CPC), ausência das cláusulas de dívida a vencer,
 * preâmbulo/assinaturas/âncoras do ZapSign preservados da casca judicial, e as
 * validações do painel liberadas só quando o tipo é 'quitacao'.
 *
 * Como rodar:
 *   node test/f43_termo_quitacao_realizada.test.js
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

const dados = {
  credor: { nome: 'COBRASQ Recuperadora de Crédito e Cobrança Ltda', genero: 'F', qualificacao: 'pessoa jurídica de direito privado, inscrita no CNPJ sob n. 34.626.848/0001-42.', assNome: 'COBRASQ', assDoc: 'CNPJ 34.626.848/0001-42' },
  devedores: [{ nome: 'Deivid Ghizzo', tipo: 'PF', genero: 'M', documento: '096.359.249-17', endereco: {}, telefone: '(46) 9981-2776' }],
  acordo: {
    total: 4250, parcelas: 0, valorParcela: 0, faixas: [], vencimento: '', pixChave: 'ccobrasq@gmail.com',
    quitacao: { dataPagamento: '2026-09-22', valorAtualizado: 4823.49, dataAtualizacao: '2026-09-22' },
  },
  dataAcordo: '2026-09-22',
  judicial: { numeroProcesso: '0002050-74.2022.8.16.0141', comarca: 'Realeza', foro: 'jec', rito: 'execucao', clausula4: { mode: '' } },
};

(async () => {
  const html = await E.montarTermoQuitacao(dados);
  const t = texto(html);
  const titulos = [...html.matchAll(/class="clause-title">([^<]+)</g)].map(m => m[1]);
  const nums = [...html.matchAll(/class="clause-num">(\d+)</g)].map(m => Number(m[1]));

  console.log('F-43 — termo de quitação já realizada');

  checa('10 cláusulas, numeradas de 1 a 10', () => {
    assert.strictEqual(titulos.length, 10, 'títulos: ' + titulos.length);
    assert.deepStrictEqual(nums, [1,2,3,4,5,6,7,8,9,10]);
  });

  checa('penhoras são LIBERADAS, não mantidas', () => {
    assert.ok(titulos.includes('Liberação das penhoras e constrições'), 'títulos: ' + titulos.join(' | '));
    assert.ok(!/Manutenção das penhoras/i.test(html), 'sobrou a cláusula de manutenção das penhoras');
    assert.ok(/bloqueios, serasajud e constrições/.test(t), 'serasajud não entrou na liberação');
    assert.ok(/anuência ao levantamento, com urgência/.test(t), 'pedido de urgência não saiu');
});

  checa('sem cláusulas de dívida a vencer', () => {
    ['Encargos por atraso', 'vencimento antecipado', 'cláusula penal', 'custódia', 'Novação',
     'penhora de salário', 'responsabilidade solidária'].forEach(termo => {
      assert.ok(!new RegExp(termo, 'i').test(t), 'ficou "' + termo + '" no termo de quitação');
    });
  });

  checa('extinção pelo pagamento (arts. 924, II e 925 do CPC)', () => {
    assert.ok(/arts\. 924, inciso II, e 925 do Código de Processo Civil/.test(t), 'requerimentos sem os arts. 924, II e 925');
    assert.ok(/art\. 515, II, do Código de Processo Civil/.test(t), 'sem o art. 515, II (título executivo judicial)');
  });

  checa('valor atualizado, valor do acordo e data do pagamento no corpo', () => {
    assert.ok(/R\$ 4\.823,49/.test(t), 'sem o valor atualizado');
    assert.ok(/R\$ 4\.250,00 \(quatro mil, duzentos e cinquenta reais\)/.test(t), 'sem o valor do acordo por extenso');
    assert.ok(/já se encontra devidamente integralizado/.test(t), 'sem a declaração de que o valor já entrou');
    assert.ok(/foi realizado em parcela única, via Pix, em 22 de setembro de 2026/.test(t), 'forma de pagamento: ' + (t.match(/O pagamento do valor total[^.]+\./) || [''])[0]);
    assert.ok(/chave ccobrasq@gmail\.com/.test(t), 'sem a chave Pix');
  });

  checa('sem token por preencher', () => {
    const sobrou = html.match(/\{\{\w+\}\}/g);
    assert.ok(!sobrou, 'tokens: ' + (sobrou || []).join(', '));
  });

  checa('casca judicial preservada: endereçamento, preâmbulo e âncoras ZapSign', () => {
    assert.ok(/Ao Juizado Especial Cível da Comarca de Realeza/.test(t));
    assert.ok(/Processo n\. 0002050-74\.2022\.8\.16\.0141/.test(t));
    assert.ok(/Exequente/.test(t) && /Deivid Ghizzo/.test(t));
    assert.ok(html.includes('&lt;&lt;assadv&gt;&gt;'), 'sem a âncora <<assadv>>');
    assert.ok(html.includes('&lt;&lt;assdev1&gt;&gt;'), 'sem a âncora <<assdev1>>');
    assert.ok(/Dois Vizinhos, Estado do Paraná, 22 de setembro de 2026/.test(t), 'fecho errado');
  });

  checa('sem dívida atualizada informada, o termo continua íntegro', () => {
    const d2 = JSON.parse(JSON.stringify(dados));
    d2.acordo.quitacao = { dataPagamento: '2026-09-22' };
    d2.acordo.pixChave = '';
    const frase = E.fraseReconhecimento(d2) + ' ' + E.frasePagamentoRealizado(d2);
    assert.ok(!/undefined|NaN/.test(frase), frase);
    assert.ok(/Por mera liberalidade/.test(frase), frase);
    assert.ok(!/via Pix/.test(frase), 'sem chave Pix não se afirma pagamento por Pix: ' + frase);
  });

  // ── o painel: validações liberadas só na quitação ──
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  checa('index.html: opção de quitação no modal e rota para montarTermoQuitacao', () => {
    assert.ok(/name="tajTipo" value="quitacao"/.test(src), 'sem a opção "quitação" no modal');
    assert.ok(/TermoEngine\.montarTermoQuitacao\(dados\)/.test(src), 'preview não chama montarTermoQuitacao');
  });
  checa('index.html: faixa e 1º vencimento não travam a quitação', () => {
    assert.ok(/!ehQuit && !dados\.acordo\.faixas\.length/.test(src), 'a validação de faixas ainda trava a quitação');
    assert.ok(/!ehQuit && !dados\.acordo\.vencimento/.test(src), 'a validação de 1º vencimento ainda trava a quitação');
    assert.ok(/ehQuit && !dados\.acordo\.quitacao\.dataPagamento/.test(src), 'a data do pagamento não é exigida');
    assert.ok(/!dados\.acordo\.total\)\{ showToast\('Informe o valor total/.test(src), 'o valor total deixou de ser exigido');
  });
  checa('index.html: quitação não regrava parcelas do acordo', () => {
    assert.ok(/if\(!ehQuit\)\{\s*\n\s*const fechou = await _tajFecharAcordo/.test(src), '_tajFecharAcordo ainda roda na quitação');
  });

  if (falhas) { console.log('\n' + falhas + ' falha(s)'); process.exit(1); }
  console.log('\ntudo ok');
})();
