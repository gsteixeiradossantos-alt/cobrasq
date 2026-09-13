/*
 * Teste F-37 — cláusulas de encargos dos termos de acordo (extrajudicial e judicial)
 * e terminologia das partes por modo.
 *
 * O caso: em 12/09/2026 o escritório decidiu, por simulação no motor de cálculo, o
 * regime dos acordos em caso de descumprimento — IPCA com piso zero, juros de 1% a.m.
 * capitalizados anualmente (Dec. 22.626/33, art. 4º), cláusula penal sobre o saldo
 * exigível, sem cumular com a multa de atraso — e a forma de chamar as partes:
 * extrajudicial = credor(a)/devedor(a); judicial = exequente/executado(a); minúsculas
 * no corpo. Os templates do painel ainda diziam "IGP/INPC" e misturavam
 * autora/ré/requerida/Credora.
 *
 * Este teste monta os dois termos com dados sintéticos (fetch simulado lendo os
 * templates do disco) e trava: cláusula nova presente, "IGP/INPC" ausente, termos
 * certos por modo, nenhum placeholder sem preencher.
 *
 * Como rodar:
 *   node test/f37_termo_clausulas_encargos.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

// fetch simulado: /templates/x.html → arquivo do repo
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
// tira <style> e os rótulos (party-label / sig-role — os únicos lugares com maiúscula) antes de achatar
const texto = html => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<div class="(?:party-label|sig-role)">[^<]*<\/div>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const rotulos = html => (html.match(/<div class="(?:party-label|sig-role)">[^<]*<\/div>/g) || []).map(x => x.replace(/<[^>]+>/g, ''));

const dados = {
  credor: { nome: 'COBRASQ Recuperadora de Crédito e Cobrança Ltda', genero: 'F', qualificacao: 'pessoa jurídica, CNPJ 34.626.848/0001-42, com sede em Dois Vizinhos, Estado do Paraná', assNome: 'COBRASQ', assDoc: 'CNPJ 34.626.848/0001-42' },
  devedores: [
    { nome: 'Maria da Silva', tipo: 'PF', genero: 'F', documento: '000.000.000-00', endereco: { rua: 'Rua A', numero: '1', bairro: 'Centro', cidade: 'Dois Vizinhos', uf: 'PR', cep: '85660-000' }, telefone: '(46) 99999-0000' },
    { nome: 'João de Souza', tipo: 'PF', genero: 'M', documento: '111.111.111-11', endereco: { cidade: 'Dois Vizinhos', uf: 'PR' } },
  ],
  acordo: { total: 6000, parcelas: 12, valorParcela: 500, vencimento: '2026-10-10', multa: 10, penal: 50, faixas: [{ qtd: 12, valor: 500 }] },
  judicial: { numeroProcesso: '0001220-30.2024.8.16.0209', comarca: 'Dois Vizinhos', vara: 'Juizado Especial Cível', clausula4: { mode: 'sisbajud', total: 1000, levExequente: 1000 } },
};

(async function () {
  console.log('\nF-37 · cláusulas de encargos + terminologia por modo nos termos de acordo\n');

  const extra = await E.montarTermoExtrajudicial(dados);
  const jud = await E.montarTermoJudicial(dados);
  const tE = texto(extra), tJ = texto(jud);

  for (const [nome, t] of [['extrajudicial', tE], ['judicial', tJ]]) {
    checa(nome + ': nenhum placeholder {{...}} sem preencher', () => assert.ok(!/\{\{\w+\}\}/.test(t), (t.match(/\{\{\w+\}\}/g) || []).join(', ')));
    checa(nome + ': cláusula nova — IPCA/IBGE com piso zero', () => {
      assert.ok(/correção monetária pela variação do IPCA\/IBGE/.test(t));
      assert.ok(/atualizado monetariamente pelo IPCA\/IBGE/.test(t));
      assert.ok(/vedada a variação negativa/.test(t));
    });
    checa(nome + ': juros de 1% a.m. capitalizados anualmente (Dec. 22.626/33, art. 4º)', () => {
      assert.ok(/capitalizados anualmente/.test(t));
      assert.ok(/art\. 4º do Decreto n\. 22\.626\/1933/.test(t));
    });
    checa(nome + ': multa de atraso 10% e cláusula penal 50% vindas do acordo', () => {
      assert.ok(/multa moratória de 10% \(dez por cento\)/.test(t));
      assert.ok(/cláusula penal compensatória de 50% \(cinquenta por cento\)/.test(t));
    });
    checa(nome + ': duas vias (manutenção × execução integral) e bis in idem afastado', () => {
      assert.ok(/Manutenção do acordo:/.test(t) && /Execução integral:/.test(t));
      assert.ok(/não será cumulada com a multa moratória/.test(t));
      assert.ok(/mera liberalidade, não importando em novação/.test(t));
    });
    checa(nome + ': "IGP/INPC" não aparece mais', () => assert.ok(!/IGP/.test(t)));
  }

  checa('extrajudicial: via "b" é execução do título extrajudicial', () => assert.ok(/execução deste título extrajudicial/.test(tE)));
  checa('extrajudicial: partes = credora/devedora (sem exequente/executada)', () => {
    assert.ok(/parte credora/.test(tE) && /parte devedora/.test(tE));
    assert.ok(!/exequente|executad/.test(tE), 'vazou termo judicial');
  });
  checa('extrajudicial: maiúscula só em rótulo — nunca "Credora"/"Devedora" no meio da frase', () => {
    const meio = tE.match(/[a-zà-ú,;] (?:Credora|Credor|Devedora|Devedor)\b/g) || [];
    assert.deepStrictEqual(meio, []);
  });
  checa('extrajudicial: rótulos = Credora / Devedora / Devedor; corpo em minúsculas', () => {
    assert.deepStrictEqual(rotulos(extra), ['Credora', 'Devedora', 'Devedor', 'Credora', 'Devedora', 'Devedor']);
    assert.ok(/Como devedora, Maria da Silva/.test(tE) && /Como devedor, João de Souza/.test(tE));
  });

  checa('judicial: via "b" é cumprimento de sentença', () => assert.ok(/cumprimento de sentença do saldo total remanescente/.test(tJ)));
  checa('judicial: partes = exequente/executada (sem autora/ré/requerida/credora/devedora)', () => {
    assert.ok(/parte exequente/.test(tJ) && /parte executada/.test(tJ));
    const velhos = tJ.match(/\b(autora|requerida|requerente|ré|credora|devedora|Credora|Devedora)\b/g) || [];
    assert.deepStrictEqual(velhos, []);
  });
  checa('judicial: rótulos = Exequente / Executada / Executado; corpo em minúsculas', () => {
    const r = rotulos(jud);
    assert.deepStrictEqual(r.slice(0, 3), ['Exequente', 'Executada', 'Executado']);
    assert.ok(r.every(x => !/Devedor|Credor|Autora|Ré/.test(x)), r.join(', '));
    assert.ok(/Como exequente, COBRASQ/.test(tJ) && /Como executada, Maria da Silva/.test(tJ) && /Como executado, João de Souza/.test(tJ));
  });
  checa('judicial: frase dos boletos fala em parte exequente / parte executada', () => {
    assert.ok(/enviados pela parte exequente à parte executada/.test(tJ));
  });
  checa('judicial: cláusula 3 remete à cláusula 5 (penal) e a 4 continua o slot variável (Sisbajud)', () => {
    assert.ok(/\(cláusula 5, alínea "a"\)/.test(tJ));
    assert.ok(/Sisbajud/.test(tJ) && /levantada em favor da parte exequente/.test(tJ));
  });

  console.log(falhas ? '\nF-37 FALHOU — ' + falhas + ' verificação(ões).' : '\nF-37 ok — cláusulas de encargos novas nos dois termos, termos certos por modo.');
  if (falhas) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
