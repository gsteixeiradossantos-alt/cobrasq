/*
 * Teste F-42 — rito do termo de acordo judicial (execução × conhecimento).
 *
 * O caso: até 18/09/2026 o termo judicial (templates/acordo-judicial.html) só sabia
 * tratar as partes por exequente/executada — o vocabulário da execução de título
 * extrajudicial e do cumprimento de sentença. Num acordo firmado dentro de ação de
 * cobrança, monitória ou de locupletamento (ação de conhecimento) esses nomes estão
 * errados: as partes são parte autora e parte requerida. Decisão do Gustavo em
 * 18/09/2026: `dados.judicial.rito` ('execucao' | 'conhecimento'), default execução
 * (nada muda para quem já usa), select "Rito" no modal do Termo pré-selecionado
 * pela etiqueta do caso e gravado em acordos.metadata.rito.
 *
 * Este teste monta o termo judicial nos dois ritos e trava: sem rito = execução
 * idêntica à de antes; conhecimento = autora/requerida em preâmbulo, corpo,
 * cláusula 4 (Sisbajud), cláusula 7 (contato), frase dos boletos e assinaturas —
 * sem sobrar nenhum "exequente"/"executad" — e o mapeamento etiqueta → rito.
 *
 * Como rodar:
 *   node test/f42_termo_judicial_rito.test.js
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
const roles = html => [...html.matchAll(/class="(?:party-label|sig-role)">([^<]+)</g)].map(m => m[1]);

function dados(rito) {
  return {
    credor: { nome: 'COBRASQ Recuperadora de Crédito e Cobrança Ltda', genero: 'F', qualificacao: 'pessoa jurídica, CNPJ 34.626.848/0001-42, com sede em Dois Vizinhos, Estado do Paraná', assNome: 'COBRASQ', assDoc: 'CNPJ 34.626.848/0001-42' },
    devedores: [
      { nome: 'Maria da Silva', tipo: 'PF', genero: 'F', documento: '000.000.000-00', endereco: { rua: 'Rua A', numero: '1', bairro: 'Centro', cidade: 'Dois Vizinhos', uf: 'PR', cep: '85660-000' }, telefone: '(46) 99999-0000' },
      { nome: 'João de Souza', tipo: 'PF', genero: 'M', documento: '111.111.111-11', endereco: {}, telefone: '' },
    ],
    advogadoExec: { nome: 'Dra. Ana Advogada', oab: 'PR 12.345' },
    acordo: { total: 780, parcelas: 5, valorParcela: 156, vencimento: '2026-10-10', multa: 10, penal: 50, faixas: [{ qtd: 5, valor: 156 }] },
    judicial: Object.assign({ numeroProcesso: '0001220-30.2024.8.16.0209', comarca: 'Dois Vizinhos', foro: 'jec',
      clausula4: { mode: 'sisbajud', valorBloqueado: 1000, levExequente: 700, levExecutado: 300, contaExecutado: { pix: '000.000.000-00', titular: 'Maria da Silva' } } }, rito ? { rito } : {}),
  };
}

// Mesma regra de index.html (_tajRitoDoStatus) — copiada aqui para travar o mapeamento
// aprovado pelo Gustavo; se a do painel mudar, este teste e o índice divergem de propósito.
const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const mRito = src.match(/function _tajRitoDoStatus\(status\)\{[\s\S]*?\n\}/);

(async function () {
  console.log('\nF-42 · rito do termo judicial: execução × conhecimento\n');

  const exec = await E.montarTermoJudicial(dados());
  const exec2 = await E.montarTermoJudicial(dados('execucao'));
  const conh = await E.montarTermoJudicial(dados('conhecimento'));
  const tE = texto(exec), tC = texto(conh);

  checa('engine: ritoJudicial default = execucao; só "conhecimento" muda', () => {
    assert.strictEqual(E.ritoJudicial(undefined), 'execucao');
    assert.strictEqual(E.ritoJudicial({}), 'execucao');
    assert.strictEqual(E.ritoJudicial({ rito: 'qualquer' }), 'execucao');
    assert.strictEqual(E.ritoJudicial({ rito: 'conhecimento' }), 'conhecimento');
  });
  checa('sem rito informado = rito execução (nada muda para quem já usa)', () => {
    assert.strictEqual(exec, exec2);
    assert.ok(/parte exequente/.test(tE) && /parte executada/.test(tE));
    assert.ok(!/autora|requerid/.test(tE), 'vazou termo de conhecimento');
  });
  checa('execução: rótulos Exequente / Executada / Executado / Exequente / Advogado(a) da parte executada', () => {
    assert.deepStrictEqual(roles(exec), ['Exequente', 'Executada', 'Executado', 'Exequente', 'Executada', 'Executado', 'Advogado(a) da parte executada']);
  });
  checa('conhecimento: nenhum exequente/executad(a/o) sobra no termo inteiro', () => {
    assert.ok(!/exequente|executad/i.test(tC), 'sobrou: ' + (tC.match(/.{40}(exequente|executad).{40}/i) || [''])[0]);
  });
  checa('conhecimento: rótulos Autora / Requerida / Requerido / Autora / Advogado(a) da parte requerida', () => {
    assert.deepStrictEqual(roles(conh), ['Autora', 'Requerida', 'Requerido', 'Autora', 'Requerida', 'Requerido', 'Advogado(a) da parte requerida']);
  });
  checa('conhecimento: preâmbulo "Como autora, COBRASQ" / "Como requerida, Maria" / "Como requerido, João"', () => {
    assert.ok(/Como autora, COBRASQ/.test(tC) && /Como requerida, Maria da Silva/.test(tC) && /Como requerido, João de Souza/.test(tC));
  });
  checa('conhecimento: corpo fala em parte autora / parte requerida (custódia, vencimento antecipado, quitação)', () => {
    assert.ok(/sob custódia da parte autora/.test(tC));
    assert.ok(/assistirá à parte autora/.test(tC));
    assert.ok(/da faculdade da autora/.test(tC));
    assert.ok(/a parte autora dará quitação plena/.test(tC));
    assert.ok(/autorização expressa da requerida/.test(tC));
  });
  checa('conhecimento: cláusula 4 (Sisbajud) e cláusula 7 (contato) seguem o rito', () => {
    assert.ok(/A parte requerida informou que houve o bloqueio/.test(tC));
    assert.ok(/em favor da parte autora/.test(tC) && /em favor da parte requerida/.test(tC));
    assert.ok(/levantamento da parte autora/.test(tC) && /levantamento da parte requerida/.test(tC));
    assert.ok(/A parte requerida Maria da Silva indica/.test(tC));
  });
  checa('conhecimento: frase dos boletos = enviados pela parte autora à parte requerida', () => {
    assert.ok(/enviados pela parte autora à parte requerida/.test(tC));
    assert.ok(/enviados pela parte exequente à parte executada/.test(tE));
  });
  checa('helpers aceitam o rito direto (fraseEntregaBoletos, papelDevedor, assinaturaAdvExec)', () => {
    assert.ok(/parte requerida/.test(E.fraseEntregaBoletos({ faixas: [{ qtd: 1, valor: 10 }] }, 'F', 'conhecimento')));
    assert.ok(/parte executada/.test(E.fraseEntregaBoletos({ faixas: [{ qtd: 1, valor: 10 }] }, 'F', true)));
    assert.strictEqual(E.papelDevedor({ tipo: 'PF', genero: 'M' }, 'conhecimento'), 'requerido');
    assert.strictEqual(E.papelDevedor({ tipo: 'PF', genero: 'M' }, true), 'executado');
    assert.ok(/da parte requerida/.test(E.assinaturaAdvExec({ nome: 'X' }, 'conhecimento')));
    assert.ok(/da parte executada/.test(E.assinaturaAdvExec({ nome: 'X' })));
  });
  checa('painel: modal tem o select #tajJudRito, passa judicial.rito e grava metadata.rito', () => {
    assert.ok(/id="tajJudRito"/.test(src));
    assert.ok(/rito:v\('tajJudRito'\)\|\|'execucao'/.test(src));
    assert.ok(/rito: \(row\.metadata && row\.metadata\.rito\)/.test(src));
    assert.ok((src.match(/\.\.\.\(rito \? \{ rito \} : \{\}\)/g) || []).length === 2, 'metadata.rito nos dois caminhos (novo e update)');
    assert.ok(/rsel\.value = ac\.rito \|\| _tajRitoDoStatus\(dev\.status\)/.test(src));
  });
  checa('painel: etiqueta → rito (mapeamento aprovado em 18/09/2026)', () => {
    assert.ok(mRito, '_tajRitoDoStatus não achada em index.html');
    const fn = new Function(mRito[0] + '; return _tajRitoDoStatus;')();
    const esperado = {
      '3. Cumprimento de Sentença': 'execucao',
      '4. Ação de Execução de Título Extrajudicial': 'execucao',
      '1. Ação de Cobrança': 'conhecimento',
      '1.1 Ação de locupletamento ilícito': 'conhecimento',
      '1.2. Ação Monitória': 'conhecimento',
      '4. Ação Monitória': 'conhecimento',
      '2.1. Acordo Judicial': 'execucao',
      'Reajuizar': 'execucao',
      'Análise': 'execucao',
      'Acordo': 'execucao',
      '': 'execucao',
    };
    for (const [st, r] of Object.entries(esperado)) assert.strictEqual(fn(st), r, st);
  });

  console.log(falhas ? '\nF-42 FALHOU — ' + falhas + ' verificação(ões).' : '\nF-42 ok — termo judicial fala a língua do rito.');
  if (falhas) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
