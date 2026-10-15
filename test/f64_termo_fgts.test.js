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
  return texto(m[0]).replace(/ ([,:;.])/g, '$1');
}

const dados = {
  credor: { nome: 'COBRASQ Recuperadora de Crédito e Cobrança Ltda', genero: 'F', qualificacao: 'pessoa jurídica, CNPJ 34.626.848/0001-42, com sede em Dois Vizinhos, Estado do Paraná', assNome: 'COBRASQ', assDoc: 'CNPJ 34.626.848/0001-42' },
  devedores: [
    { nome: 'Maria da Silva', tipo: 'PF', genero: 'F', documento: '000.000.000-00', endereco: { rua: 'Rua A', numero: '1', bairro: 'Centro', cidade: 'Dois Vizinhos', uf: 'PR', cep: '85660-000' }, telefone: '(46) 99999-0000' },
  ],
  acordo: { total: 780, parcelas: 5, valorParcela: 156, vencimento: '2026-10-10', multa: 10, penal: 50, faixas: [{ qtd: 5, valor: 156 }] },
  judicial: { numeroProcesso: '0001220-30.2024.8.16.0209', comarca: 'Dois Vizinhos', vara: 'Juizado Especial Cível', clausula4: { mode: 'sisbajud', total: 1000, levExequente: 1000, totalAcordo: 1780 } },
};

const TEXTO = 'Eu, Maria da Silva, CPF 000.000.000-00, declaro que li esta cláusula com atenção, que entendi o seu conteúdo e que concordo com ela por livre escolha: ' +
  'a) sei que o saldo da minha conta vinculada ao FGTS é, em regra, impenhorável (art. 2º, § 2º, da Lei n. 8.036/1990); ' +
  'b) mesmo assim, se eu descumprir este acordo, autorizo, de forma expressa, irrevogável e irretratável, que esse saldo seja usado para pagar o débito remanescente, até o limite do saldo devedor; ' +
  'c) concordo que o Juízo oficie à Caixa Econômica Federal para transferir o valor à conta judicial, o que ajusto nos termos do art. 190 do Código de Processo Civil.';

(async function () {
  console.log('\nF-64 · cláusula de uso do saldo do FGTS nos termos de acordo\n');

  const extra = await E.montarTermoExtrajudicial(dados);
  const jud = await E.montarTermoJudicial(dados);

  checa('extrajudicial cl. 07: FGTS logo após a penhora (06), texto aprovado, parte devedora', () => {
    assert.ok(/Da autorização para penhora de valores/.test(clausula(extra, '06')));
    const c = clausula(extra, '07');
    assert.ok(/Da declaração de ciência e autorização para uso do saldo do FGTS/.test(c));
    assert.ok(c.includes(TEXTO), c);
  });
  checa('judicial: FGTS logo após a penhora de salário, texto aprovado, parte executada', () => {
    const nums = [...jud.matchAll(/class="clause-num">(\d+)<\/span><h2 class="clause-title">([^<]*)/g)];
    const iPen = nums.findIndex(m => /penhora de salário/.test(m[2]));
    assert.ok(iPen >= 0 && /uso do saldo do FGTS/.test(nums[iPen + 1][2]), 'FGTS não vem logo após a penhora');
    const c = clausula(jud, nums[iPen + 1][1]);
    assert.ok(c.includes(TEXTO), c);
    assert.ok(!/devedora|\{\{/.test(c), 'vazou termo extrajudicial ou placeholder');
  });
  checa('numeração em sequência nos dois termos', () => {
    for (const h of [extra, jud]) {
      const ns = [...h.matchAll(/class="clause-num">(\d+)</g)].map(m => Number(m[1]));
      ns.forEach((n, i) => assert.strictEqual(n, i + 1));
    }
  });

  checa('sem comentários-marcadores <!--fgts--> no termo pronto', () => {
    for (const h of [extra, jud]) assert.ok(!/fgts-->/.test(h));
  });

  // só empresa: não há conta vinculada — a cláusula sai e a numeração fecha
  const empresa = { nome: 'Mercado Exemplo Ltda', tipo: 'PJ', documento: '00.000.000/0001-00', endereco: dados.devedores[0].endereco, telefone: '(46) 3536-0000' };
  const soPJ = Object.assign({}, dados, { devedores: [empresa] });
  const extraPJ = await E.montarTermoExtrajudicial(soPJ);
  const judPJ = await E.montarTermoJudicial(soPJ);
  checa('só empresa: cláusula do FGTS sai dos dois termos', () => {
    for (const h of [extraPJ, judPJ]) assert.ok(!/FGTS/.test(h) && !/fgts-->/.test(h));
  });
  checa('só empresa: extrajudicial renumera com dois dígitos (01…11), restrições vira 07', () => {
    const ns = [...extraPJ.matchAll(/class="clause-num">(\d+)</g)].map(m => m[1]);
    assert.deepStrictEqual(ns, ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11']);
    assert.ok(/Das restrições/.test(clausula(extraPJ, '07')));
    assert.ok(/com a devolução dos títulos na forma da cláusula 05/.test(clausula(extraPJ, '10')));
  });
  checa('só empresa: judicial em sequência, sócios logo após a penhora de salário', () => {
    const t = [...judPJ.matchAll(/class="clause-num">(\d+)<\/span><h2 class="clause-title">([^<]*)/g)];
    t.forEach((m, i) => assert.strictEqual(Number(m[1]), i + 1));
    const i = t.findIndex(m => /penhora de salário/.test(m[2]));
    assert.ok(/responsabilidade solidária/.test(t[i + 1][2]));
  });

  // empresa + pessoa física (ex.: o sócio assina junto): a PF tem FGTS — a cláusula fica
  const mista = Object.assign({}, dados, { devedores: [empresa, dados.devedores[0]] });
  const extraM = await E.montarTermoExtrajudicial(mista);
  const judM = await E.montarTermoJudicial(mista);
  checa('empresa + pessoa física: FGTS presente, extrajudicial na 07', () => {
    assert.ok(/uso do saldo do FGTS/.test(clausula(extraM, '07')));
    assert.ok(/uso do saldo do FGTS/.test(judM));
  });

  checa('negrito no nome/CPF, na declaração de leitura e no "de forma expressa, irrevogável e irretratável"', () => {
    const bruto = extra.match(/clause-num">07<[\s\S]*?<\/article>/)[0];
    for (const t of ['<strong>Maria da Silva, CPF 000.000.000-00</strong>',
      '<strong>li esta cláusula com atenção, que entendi o seu conteúdo e que concordo com ela por livre escolha</strong>',
      '<strong>de forma expressa, irrevogável e irretratável</strong>']) assert.ok(bruto.includes(t), t);
  });

  // empresa + duas pessoas físicas: declaração no plural, só com as PF
  const joao = Object.assign({}, dados.devedores[0], { nome: 'João de Souza', genero: 'M', documento: '11111111111' });
  const plural = Object.assign({}, dados, { devedores: [empresa, dados.devedores[0], joao] });
  const extraP = await E.montarTermoExtrajudicial(plural);
  const judP = await E.montarTermoJudicial(plural);
  checa('duas pessoas físicas: "Nós, …, e …, declaramos", sem a empresa', () => {
    for (const h of [extraP, judP]) {
      const c = texto(h.match(/uso do saldo do FGTS[\s\S]*?<\/article>/)[0]).replace(/ ([,:;.])/g, '$1');
      assert.ok(c.includes('Nós, Maria da Silva, CPF 000.000.000-00, e João de Souza, CPF 111.111.111-11, declaramos que lemos esta cláusula com atenção, que entendemos o seu conteúdo e que concordamos com ela por livre escolha:'), c);
      assert.ok(c.includes('a) sabemos que o saldo de nossas contas vinculadas ao FGTS'), c);
      assert.ok(c.includes('b) mesmo assim, se descumprirmos este acordo, autorizamos, de forma expressa, irrevogável e irretratável, que esses saldos sejam usados'), c);
      assert.ok(c.includes('c) concordamos que o Juízo oficie à Caixa Econômica Federal para transferir os valores à conta judicial, o que ajustamos'), c);
      assert.ok(!/MERCADO/i.test(c), 'empresa entrou na declaração');
    }
  });

  console.log(falhas ? '\nF-64 FALHOU — ' + falhas + ' verificação(ões).' : '\nF-64 ok — cláusula do FGTS nos dois termos.');
  if (falhas) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
