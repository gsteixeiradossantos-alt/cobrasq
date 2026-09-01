/*
 * Teste F-15 — o repasse pareia por NOME + CARTEIRA + vencimento no mesmo mês.
 *
 * `_finRepasseLiberado()` diz quais despesas de repasse já têm lastro. Até 31/08/2026 ela
 * escolhia o melhor palpite dentro do balde "primeiro nome + mês do vencimento". Dois
 * defeitos, os dois medidos sobre as 364 despesas reais:
 *
 *  1. A marca ` · verificar` do pente-fino cegava `_finRepasseNomeDevedor`. A regra que
 *     tira a numeração exige o número no FIM, e com a marca depois dele nada era
 *     removido — o "nome do devedor" virava a descrição inteira, numeração e tudo. Das 14
 *     despesas liberadas naquele dia, 13 casaram só pelo primeiro nome. O F-11 consertou
 *     quatro leitores da descrição e deixou este de fora.
 *  2. Sem nome inteiro, o desempate ruía: bastava o boleto certo faltar naquele mês para
 *     uma parcela de OUTRA pessoa de mesmo primeiro nome liberar o repasse.
 *
 * Agora nome inteiro é REQUISITO, a carteira elimina o que sobra de ambíguo, e a data
 * escolhe entre parcelas da mesma pessoa no mesmo mês. Sem candidato, a despesa fica sem
 * par — o repasse não é anunciado, que é o erro barato.
 *
 * Como rodar:
 *   node test/f15_pareamento_repasse.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function corta(marca, fim) {
  const i = HTML.indexOf(marca);
  assert.ok(i >= 0, `não achei no index.html: ${marca}`);
  const j = HTML.indexOf(fim, i + marca.length);
  assert.ok(j > i, `não achei o fim de ${marca}`);
  return HTML.slice(i, j + fim.length);
}

// ── Sandbox com um Supabase de mentira ─────────────────────────────────────────────
// Só o encadeamento que a função usa. `cobrancas` devolve o mapa cobrança → carteira.
function monta(lancamentos, cobrancas, hoje) {
  const tabela = (nome) => {
    if (nome === 'cobrancas') {
      return { select: () => ({ in: (c, ids) => Promise.resolve({ data: cobrancas.filter(x => ids.includes(x.id)) }) }) };
    }
    const f = [];
    const api = {
      select: () => api,
      eq: (c, v) => { f.push(r => r[c] === v); return api; },
      not: (c, op, v) => {
        if (op === 'is') f.push(r => r[c] != null);
        else if (op === 'ilike') f.push(r => !new RegExp(String(v).replace(/%/g, '.*'), 'i').test(String(r.descricao || '')));
        return api;
      },
      limit: () => Promise.resolve({ data: lancamentos.filter(r => f.every(fn => fn(r))) }),
    };
    return api;
  };
  const ctx = {
    getSupabase: () => ({ from: tabela }), console,
    isoLocal: () => hoje || '2026-08-31',
    Date, Set, Map, String, Number, Math, Object, Promise, JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(
    corta('const FIN_MARCA_PENTE', '\n') + corta('const _finDescCrua', '\n')
    + corta('const FIN_REP_PREFIXOS', '\n') + corta('const FIN_REP_SUFIXOS', '\n') + corta('const FIN_REP_ANOTA', '\n')
    + corta('function _finRepasseNomeDevedor', '\n}') + corta('function _finRepasseChave', '\n}')
    + corta('function _finPago', '\n') + corta('async function _finRepasseLiberado', '\n}\n')
    + 'this._liberado = _finRepasseLiberado; this._nome = _finRepasseNomeDevedor;',
    ctx
  );
  return ctx;
}
const vazio = monta([], [], '2026-08-31');

// ── 1. O nome do devedor sobrevive à marca e às anotações ──────────────────────────
const nome = vazio._nome;
assert.strictEqual(nome('Salete Vieira dos Santos 11/11 · verificar'), 'Salete Vieira dos Santos',
  'a marca do pente-fino não pode virar parte do nome');
assert.strictEqual(nome('Salete Vieira dos Santos - pagar 2/6 · verificar'), 'Salete Vieira dos Santos');
// O caso que quebrou na primeira tentativa: a regra da numeração é gulosa e leva o
// "pagar" de "senão pagar", deixando "- executar senão" para trás.
assert.strictEqual(nome('Fernanda Dambros - executar senão pagar 8/10 · verificar'), 'Fernanda Dambros',
  '"executar senão" sem o "pagar" continua sendo anotação, não sobrenome');
assert.strictEqual(nome('Fernanda Dambros 4/6 · verificar'), 'Fernanda Dambros');
assert.strictEqual(nome('Repasse ao credor — Fulano de Tal 3/9'), 'Fulano de Tal');

// ── 2. Nome inteiro é requisito: homônimo de primeiro nome não libera ──────────────
// Repasse do Leonardo FORTES em outubro; a parcela DELE não vence em outubro. A única
// entrada "leonardo" do mês é de outra pessoa, e está paga. Antes, liberava.
{
  const ctx = monta([
    { id: 1, descricao: 'Leonardo dos Santos Fortes', valor: -500, data_vencimento: '2026-10-10',
      status: 0, data_pagamento: null, conciliado: false, credor_id: 'odonto', tipo_movimento: 0, raw_payload: null },
    { id: 2, descricao: 'Leonardo Pereira da Silva 2/6', valor: 300, data_vencimento: '2026-10-20',
      status: 1, data_pagamento: '2026-10-20', conciliado: false, credor_id: null, cobranca_id: null, tipo_movimento: 1 },
  ], [], '2026-10-31');
  return ctx._liberado().then(r => {
    assert.strictEqual(r.itens.length, 0, 'parcela de outra pessoa NÃO pode liberar o repasse');
    assert.strictEqual(r.semPar, 1, 'sem candidato de nome igual, a despesa fica sem par');
    return proximo();
  }).then(fim).catch(erro);
}

function proximo() {
  // ── 3. Carteira elimina o ambíguo, mas só quando os DOIS lados sabem ─────────────
  // Duas pessoas de nome idêntico é raro; carteira diferente no mesmo caso, não. Aqui a
  // entrada é da carteira B e o repasse é para a carteira A: não pode liberar.
  const conflito = monta([
    { id: 1, descricao: 'Fulano de Tal', valor: -200, data_vencimento: '2026-08-10',
      status: 0, data_pagamento: null, conciliado: false, credor_id: 'A', tipo_movimento: 0, raw_payload: null },
    { id: 2, descricao: 'Fulano de Tal 3/9', valor: 200, data_vencimento: '2026-08-10',
      status: 1, data_pagamento: '2026-08-10', conciliado: false, credor_id: null, cobranca_id: 'cob', tipo_movimento: 1 },
  ], [{ id: 'cob', cliente_id: 'B' }], '2026-08-31');

  return conflito._liberado().then(r => {
    assert.strictEqual(r.itens.length, 0, 'carteira diferente não libera repasse');

    // Mesma cena, mas a entrada NÃO sabe a carteira: aí não dá para eliminar, e libera.
    const semCarteira = monta([
      { id: 1, descricao: 'Fulano de Tal', valor: -200, data_vencimento: '2026-08-10',
        status: 0, data_pagamento: null, conciliado: false, credor_id: 'A', tipo_movimento: 0, raw_payload: null },
      { id: 2, descricao: 'Fulano de Tal 3/9', valor: 200, data_vencimento: '2026-08-10',
        status: 1, data_pagamento: '2026-08-10', conciliado: false, credor_id: null, cobranca_id: null, tipo_movimento: 1 },
    ], [], '2026-08-31');
    return semCarteira._liberado();
  }).then(r => {
    assert.strictEqual(r.itens.length, 1,
      'entrada sem carteira conhecida não pode ser eliminada — 212 das 925 receitas estão assim');

    // ── 4. A entrada continua sendo CONSUMIDA ────────────────────────────────────
    // Duas despesas do mesmo devedor no mesmo mês, uma entrada só: libera UMA. Sem isto,
    // o caso Valdair volta (três despesas apontando um boleto só de R$ 214,00).
    const disputa = monta([
      { id: 1, descricao: 'Fulano de Tal 1/2', valor: -100, data_vencimento: '2026-08-10',
        status: 0, data_pagamento: null, conciliado: false, credor_id: 'A', tipo_movimento: 0, raw_payload: null },
      { id: 2, descricao: 'Fulano de Tal 2/2', valor: -100, data_vencimento: '2026-08-20',
        status: 0, data_pagamento: null, conciliado: false, credor_id: 'A', tipo_movimento: 0, raw_payload: null },
      { id: 3, descricao: 'Fulano de Tal 5/9', valor: 200, data_vencimento: '2026-08-10',
        status: 1, data_pagamento: '2026-08-10', conciliado: false, credor_id: null, cobranca_id: null, tipo_movimento: 1 },
    ], [], '2026-08-31');
    return disputa._liberado();
  }).then(r => {
    assert.strictEqual(r.itens.length, 1, 'uma entrada libera UM repasse, nunca dois');
    assert.strictEqual(r.itens[0].id, 1, 'a despesa que vence antes escolhe primeiro');

    // ── 5. Vínculo gravado tem precedência sobre tudo ────────────────────────────
    const gravado = monta([
      { id: 1, descricao: 'Nome Que Nao Bate', valor: -100, data_vencimento: '2026-08-10',
        status: 0, data_pagamento: null, conciliado: false, credor_id: 'A', tipo_movimento: 0,
        raw_payload: { repasse_de_lancamento_id: 9 } },
      { id: 9, descricao: 'Outra Pessoa 5/9', valor: 100, data_vencimento: '2026-08-10',
        status: 1, data_pagamento: '2026-08-10', conciliado: false, credor_id: null, cobranca_id: null, tipo_movimento: 1 },
    ], [], '2026-08-31');
    return gravado._liberado();
  }).then(r => {
    assert.strictEqual(r.itens.length, 1, 'vínculo gravado vale mesmo com nome diferente');
    assert.strictEqual(r.itens[0].exato, true, 'e continua marcado como exato');
  });
}

function fim() { console.log('F-15 ok — repasse pareia por nome inteiro + carteira + vencimento.'); }
function erro(e) { console.error(e); process.exit(1); }
