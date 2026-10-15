/*
 * Teste F-65 — cláusula das custas no termo de acordo judicial (Vara × Juizado).
 *
 * O caso: no 0000943-85.2025.8.16.0174 (cumprimento de sentença na Vara Cível),
 * o acordo não dizia quem pagava as custas e a homologação as dividiu meio a meio
 * pelo art. 90, § 2º, do CPC ("nada tendo as partes disposto quanto às despesas,
 * estas serão divididas igualmente"). Decisão do Gustavo em 15/10/2026: acordo
 * judicial fora do Juizado já sai com as custas a cargo da parte devedora.
 *
 * Trava: foro 'vara' → cláusula "Das custas processuais" no termo de parcelamento
 * e no de quitação, com a parte devedora do rito, numeração em sequência e sem
 * marcador sobrando; foro 'jec' (ou vazio) → nenhuma menção a custas.
 *
 * Como rodar:
 *   node test/f65_termo_custas_vara.test.js
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
const titulos = html => [...html.matchAll(/class="clause-title">([^<]+)</g)].map(m => m[1]);
const nums = html => [...html.matchAll(/class="clause-num">(\d+)</g)].map(m => Number(m[1]));
const seq = n => Array.from({ length: n }, (_, i) => i + 1);

function dados(foro, rito, quitacao) {
  const d = {
    credor: { nome: 'COBRASQ Recuperadora de Crédito e Cobrança Ltda', genero: 'F', qualificacao: 'pessoa jurídica, CNPJ 34.626.848/0001-42', assNome: 'COBRASQ', assDoc: 'CNPJ 34.626.848/0001-42' },
    devedores: [{ nome: 'Maria da Silva', tipo: 'PF', genero: 'F', documento: '000.000.000-00', endereco: {}, telefone: '(46) 99999-0000' }],
    acordo: { total: 780, parcelas: 5, valorParcela: 156, vencimento: '2026-11-10', multa: 10, penal: 50, faixas: [{ qtd: 5, valor: 156 }] },
    dataAcordo: '2026-10-15',
    judicial: { numeroProcesso: '0000943-85.2025.8.16.0174', comarca: 'União da Vitória', foro, rito: rito || 'execucao', clausula4: { mode: '' } },
  };
  if (quitacao) {
    d.acordo = { total: 780, parcelas: 0, valorParcela: 0, faixas: [], vencimento: '', pixChave: 'ccobrasq@gmail.com',
      quitacao: { dataPagamento: '2026-10-15', valorAtualizado: 800, dataAtualizacao: '2026-10-15' } };
  }
  return d;
}

(async () => {
  console.log('F-65 — custas a cargo da parte devedora no acordo judicial da Vara');

  const varaExec = await E.montarTermoJudicial(dados('vara'));
  const varaConh = await E.montarTermoJudicial(dados('vara', 'conhecimento'));
  const jec = await E.montarTermoJudicial(dados('jec'));
  const semForo = await E.montarTermoJudicial(dados(''));
  const quitVara = await E.montarTermoQuitacao(dados('vara', null, true));
  const quitJec = await E.montarTermoQuitacao(dados('jec', null, true));

  await checa('Vara (execução): cláusula das custas a cargo da parte executada, com o art. 90, § 2º', () => {
    assert.ok(titulos(varaExec).includes('Das custas processuais'), titulos(varaExec).join(' | '));
    const t = texto(varaExec);
    assert.ok(/custas processuais e as demais despesas do processo, inclusive as remanescentes e as que vierem a ser apuradas pelo Contador Judicial, ficam a cargo exclusivo da parte executada/.test(t), 'texto da cláusula');
    assert.ok(/art\. 90, § 2º, do Código de Processo Civil/.test(t), 'falta o art. 90, § 2º');
  });

  await checa('Vara (conhecimento): parte requerida', () => {
    assert.ok(/a cargo exclusivo da parte requerida/.test(texto(varaConh)));
  });

  await checa('Vara: cláusula antes da assinatura eletrônica, numeração em sequência, sem marcador', () => {
    const tt = titulos(varaExec);
    assert.strictEqual(tt.indexOf('Das custas processuais') + 1, tt.indexOf('Da assinatura eletrônica e da validade do título'));
    assert.deepStrictEqual(nums(varaExec), seq(tt.length));
    assert.ok(!/custas-->/.test(varaExec), 'sobrou marcador <!--custas-->');
  });

  await checa('Juizado e foro vazio: nenhuma menção a custas, uma cláusula a menos', () => {
    for (const h of [jec, semForo]) {
      assert.ok(!/custas/i.test(texto(h)), 'apareceu "custas" no Juizado');
      assert.ok(!/custas-->/.test(h), 'sobrou marcador');
      assert.deepStrictEqual(nums(h), seq(titulos(h).length));
    }
    assert.strictEqual(titulos(jec).length + 1, titulos(varaExec).length);
  });

  await checa('Quitação: Vara com a cláusula (11, em sequência), Juizado sem (10)', () => {
    assert.ok(titulos(quitVara).includes('Das custas processuais'));
    assert.deepStrictEqual(nums(quitVara), seq(11));
    assert.ok(!/custas/i.test(texto(quitJec)));
    assert.deepStrictEqual(nums(quitJec), seq(10));
  });

  if (falhas) { console.log('\n' + falhas + ' falha(s)'); process.exit(1); }
  console.log('\ntudo ok');
})();
