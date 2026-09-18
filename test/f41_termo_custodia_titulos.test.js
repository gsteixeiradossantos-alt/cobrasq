/*
 * Teste F-41 — custódia dos títulos até a quitação nos termos de acordo.
 *
 * O caso: até 18/09/2026 a cláusula "Da devolução dos documentos" (05 no extrajudicial,
 * 8 no judicial) liberava o cheque/nota/contrato original ao devedor logo após a
 * primeira parcela. Com o título fora da mão da credora, um acordo descumprido só
 * podia ser cobrado pelo próprio termo. Em 18/09/2026 o escritório decidiu manter o
 * título sob custódia até a quitação integral, com cláusula expressa de não novação
 * (CC 360/361), reconhecimento do débito (CC 202, VI), garantias de fiadores/avalistas
 * preservadas, promessa de não apresentar/protestar enquanto adimplente, escolha da via
 * de cobrança no vencimento antecipado, devolução em 10 dias úteis após a quitação
 * (estrutura fechada pelo Dr. Gustavo em 18/09/2026: caput + §§ 1º a 4º)
 * (custo de envio informado antes; comprovante a pedido) e inutilização por
 * cancelamento visível ("PAGO", rasura, corte) após 30 dias.
 *
 * Este teste monta os dois termos (fetch simulado) e trava: a cláusula nova está lá,
 * a devolução não é mais na primeira parcela, os termos das partes seguem o modo e a
 * cláusula 10 do extrajudicial remete à devolução.
 *
 * Como rodar:
 *   node test/f41_termo_custodia_titulos.test.js
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
// corpo de uma cláusula pelo número (achatado)
function clausula(html, num) {
  const re = new RegExp('<span class="clause-num">' + num + '</span>[\\s\\S]*?</article>');
  const m = html.match(re);
  assert.ok(m, 'cláusula ' + num + ' não encontrada');
  return texto(m[0]);
}

const dados = {
  credor: { nome: 'COBRASQ Recuperadora de Crédito e Cobrança Ltda', genero: 'F', qualificacao: 'pessoa jurídica, CNPJ 34.626.848/0001-42, com sede em Dois Vizinhos, Estado do Paraná', assNome: 'COBRASQ', assDoc: 'CNPJ 34.626.848/0001-42' },
  devedores: [
    { nome: 'Maria da Silva', tipo: 'PF', genero: 'F', documento: '000.000.000-00', endereco: { rua: 'Rua A', numero: '1', bairro: 'Centro', cidade: 'Dois Vizinhos', uf: 'PR', cep: '85660-000' }, telefone: '(46) 99999-0000' },
  ],
  acordo: { total: 780, parcelas: 5, valorParcela: 156, vencimento: '2026-10-10', multa: 10, penal: 50, faixas: [{ qtd: 5, valor: 156 }] },
  judicial: { numeroProcesso: '0001220-30.2024.8.16.0209', comarca: 'Dois Vizinhos', vara: 'Juizado Especial Cível', clausula4: { mode: 'sisbajud', total: 1000, levExequente: 1000 } },
};

(async function () {
  console.log('\nF-41 · custódia dos títulos até a quitação nos termos de acordo\n');

  const extra = await E.montarTermoExtrajudicial(dados);
  const jud = await E.montarTermoJudicial(dados);
  const c5 = clausula(extra, '05');
  const c8 = clausula(jud, '8');

  for (const [nome, c] of [['extrajudicial cl. 05', c5], ['judicial cl. 8', c8]]) {
    checa(nome + ': devolução não é mais após a primeira parcela', () => assert.ok(!/primeira parcela/.test(c)));
    checa(nome + ': títulos sob custódia, sem apresentação/protesto enquanto adimplente', () => {
      assert.ok(/permanecerão sob custódia/.test(c));
      assert.ok(/não os apresentará a pagamento, protesto, endosso/.test(c));
    });
    checa(nome + ': vencimento antecipado → cobrança pelo termo ou pelos títulos, sem duplicidade', () => {
      assert.ok(/por este instrumento ou pelos títulos originais/.test(c));
      assert.ok(/vedada a cobrança em duplicidade/.test(c));
    });
    checa(nome + ': devolução em 10 dias úteis após a quitação; custo de envio informado antes; comprovante a pedido', () => {
      assert.ok(/Quitado integralmente o débito/.test(c) && /10 \(dez\) dias úteis/.test(c));
      assert.ok(/custo do envio será informado previamente/.test(c));
      assert.ok(/emitirá comprovante da entrega ou da inutilização/.test(c));
    });
    checa(nome + ': inutilização por cancelamento visível após 30 dias; numeração fecha no § 4º', () => {
      assert.ok(/§ 4º Decorridos/.test(c) && !/§ 5º/.test(c));
      assert.ok(/30 \(trinta\) dias/.test(c));
      assert.ok(/cancelamento visível, aposição de carimbo "PAGO", rasura, corte/.test(c));
    });
    checa(nome + ': nenhum placeholder {{...}} sem preencher', () => assert.ok(!/\{\{\w+\}\}/.test(c)));
  }

  checa('extrajudicial cl. 05: caput = não novação (CC 360/361), reconhecimento (CC 202, VI), garantias de fiadores/avalistas preservadas', () => {
    assert.ok(/^[^§]*não configura novação/.test(c5.replace(/^.*?clause-body/, '')) || /não configura novação[^§]*§ 1º/.test(c5), 'não novação deve vir antes do § 1º');
    assert.ok(/não configura novação \(arts\. 360 e 361 do Código Civil\)/.test(c5));
    assert.ok(/art\. 202, VI, do Código Civil/.test(c5));
    assert.ok(/fiadores, avalistas, coobrigados ou terceiros garantidores/.test(c5));
    assert.ok(/somente se extinguindo com a quitação integral/.test(c5));
  });
  checa('extrajudicial cl. 05: remete ao vencimento antecipado da cláusula 04; partes = credora/devedora', () => {
    assert.ok(/\(cláusula 04\)/.test(c5));
    assert.ok(/parte devedora/.test(c5) && /credora/.test(c5) && !/exequente|executad/.test(c5));
  });
  checa('extrajudicial cl. 10: quitação com devolução dos títulos na forma da cláusula 05', () => {
    assert.ok(/com a devolução dos títulos na forma da cláusula 05/.test(clausula(extra, '10')));
  });

  checa('judicial cl. 8: sem caput de novação (a cláusula 6 já a afasta); §§ 1º a 4º; remete ao vencimento antecipado da cláusula 5', () => {
    assert.ok(!/não configura novação/.test(c8) && /§ 1º Os títulos/.test(c8) && /§ 4º/.test(c8) && !/§ 5º/.test(c8));
    assert.ok(/\(cláusula 5\)/.test(c8));
    assert.ok(/não configura novação/.test(clausula(jud, '6')));
  });
  checa('judicial cl. 8: partes = exequente/executada (sem credora/devedora)', () => {
    assert.ok(/parte executada/.test(c8) && /parte exequente/.test(c8));
    assert.ok(!/credora|devedora/.test(c8), 'vazou termo extrajudicial');
  });

  console.log(falhas ? '\nF-41 FALHOU — ' + falhas + ' verificação(ões).' : '\nF-41 ok — títulos sob custódia até a quitação nos dois termos.');
  if (falhas) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
