/*
 * Teste F-64 — autorização de uso do saldo do FGTS nos termos de acordo.
 *
 * Em 08/10/2026 o escritório decidiu incluir nos dois modelos (extrajudicial e judicial),
 * logo após a cláusula de penhora de salário, a autorização expressa do devedor para que,
 * no descumprimento, o Juízo oficie à Caixa e o saldo do FGTS pague o débito remanescente.
 * Base: TJPR, MS 0042621-54.2024.8.16.0000 (10ª CC) — FGTS oferecido pelo próprio devedor,
 * a Caixa não pode se opor. Na petição de penhora, ler a cláusula do acordo antes de pedir.
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
  judicial: { numeroProcesso: '0001220-30.2024.8.16.0209', comarca: 'Dois Vizinhos', vara: 'Juizado Especial Cível', clausula4: { mode: 'sisbajud', total: 1000, levExequente: 1000, totalAcordo: 1780 } },
};

const TEXTO = 'autoriza expressamente a utilização do saldo existente em sua conta vinculada ao FGTS para pagamento do débito remanescente e concorda que o Juízo oficie à Caixa Econômica Federal para transferência do valor à conta judicial, até o limite do saldo devedor.';

(async function () {
  console.log('\nF-64 · cláusula de uso do saldo do FGTS nos termos de acordo\n');

  const extra = await E.montarTermoExtrajudicial(dados);
  const jud = await E.montarTermoJudicial(dados);

  checa('extrajudicial cl. 07: FGTS logo após a penhora (06), texto aprovado, parte devedora', () => {
    assert.ok(/Da autorização para penhora de valores/.test(clausula(extra, '06')));
    const c = clausula(extra, '07');
    assert.ok(/Da autorização para uso do saldo do FGTS/.test(c));
    assert.ok(c.includes('Em caso de descumprimento deste acordo, a parte devedora ' + TEXTO), c);
  });
  checa('judicial: FGTS logo após a penhora de salário, texto aprovado, parte executada', () => {
    const nums = [...jud.matchAll(/class="clause-num">(\d+)<\/span><h2 class="clause-title">([^<]*)/g)];
    const iPen = nums.findIndex(m => /penhora de salário/.test(m[2]));
    assert.ok(iPen >= 0 && /uso do saldo do FGTS/.test(nums[iPen + 1][2]), 'FGTS não vem logo após a penhora');
    const c = clausula(jud, nums[iPen + 1][1]);
    assert.ok(c.includes('Em caso de descumprimento deste acordo, a parte executada ' + TEXTO), c);
    assert.ok(!/devedora|\{\{/.test(c), 'vazou termo extrajudicial ou placeholder');
  });
  checa('numeração em sequência nos dois termos', () => {
    for (const h of [extra, jud]) {
      const ns = [...h.matchAll(/class="clause-num">(\d+)</g)].map(m => Number(m[1]));
      ns.forEach((n, i) => assert.strictEqual(n, i + 1));
    }
  });

  console.log(falhas ? '\nF-64 FALHOU — ' + falhas + ' verificação(ões).' : '\nF-64 ok — cláusula do FGTS nos dois termos.');
  if (falhas) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
