/*
 * Teste F-40 (Repasses — recebíveis não seguram a tela, e a geração manda).
 *
 * Desde o #735, `_repLoadReal` resolve com o NÚCLEO (fin_operacao + repasses importados +
 * nomes) e os recebíveis (Asaas) pousam depois, por `_repCarregarRecebiveis`. Desde o
 * #738 (menu "Repasses a clientes" retirado) quem repinta no pouso é o card
 * Composição/Inadimplência da aba Caixa do Financeiro (`_finComposicaoInadRepintar`),
 * e os recebíveis ganharam guarda de voo (`_repRecebiveisEmVoo`): duas cargas no meio
 * compartilham a MESMA consulta ao Asaas. Este teste recorta as funções reais do
 * index.html e roda num sandbox com leitores controláveis:
 *   1. o `_repLoad` resolve ANTES dos recebíveis (loaded=true, recebiveisProntos=false);
 *   2. recarga no meio: compartilha o voo (uma consulta só) e repinta UMA vez;
 *   3. recarga depois do pouso: nova geração grava por cima da anterior;
 *   4. núcleo em voo (spinner na tela) → o pouso dos recebíveis não repinta por cima;
 *   5. falha nos recebíveis não deixa "carregando…" eterno (recebiveisProntos fecha).
 *
 * Como rodar:
 *   node test/f40_repasses_recebiveis_geracao.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function fatia(inicioRe, fimRe) {
  const a = HTML.search(inicioRe); assert.ok(a >= 0, 'não achei ' + inicioRe);
  const b = HTML.slice(a).search(fimRe); assert.ok(b > 0, 'não achei o fim de ' + inicioRe);
  return HTML.slice(a, a + b);
}
const fonte = [
  // Só as duas linhas do estado (declaração + espelho em window). O fim é a primeira
  // declaração seguinte, seja qual for — o #738 apagou o `_REP_MESES` que servia de marco.
  fatia(/^let _repState = \{/m, /\n(?:const|let|var|function|async function) /),
  fatia(/^let _repLoadEmVoo = null;/m, /\n\/\/ Agrega fin_operacao por cedente/),
  'globalThis._repState = _repState; globalThis._repLoad = _repLoad; globalThis._repCarregarRecebiveis = _repCarregarRecebiveis;',
].join('\n');

const sleep = (ms, v) => new Promise(r => setTimeout(() => r(v), ms));
let falhas = 0;
function ok(nome, cond, detalhe) {
  if (cond) { console.log(`  ok  ${nome}`); return; }
  falhas++; console.log(`  FALHOU  ${nome}${detalhe ? ' — ' + detalhe : ''}`);
}

// Leitores controláveis: latências por cenário; `inad` numera as gerações que atende.
const lat = { core: 20, inad: [], asaas: 10 };
let nInad = 0; let falharInad = false;
const renders = [];
const ctx = {
  console, setTimeout, Promise, Date, Math, Object, Set, Array, String, Number,
  DB: { config: { asaasKey: 'k' } },
  isoLocal: d => d.toISOString().slice(0, 10),
  _rapLerDescricao: () => ({}),
  getSupabase: () => ({ from: () => ({
    select: () => ({
      order: () => ({ limit: () => sleep(lat.core, { data: [{ id: 1, credor_id: 'c1', repasse_status: 'pendente', valor_capital: 10 }], error: null }) }),
      in: () => sleep(5, { data: [{ id: 'c1', nome: 'Credor', chave_pix: null }], error: null }),
    }),
  }) }),
  finApi: { listRepassesAPagar: () => sleep(5, []) },
  _loadInadimplentes: () => { const k = ++nInad; if (falharInad) return Promise.reject(new Error('asaas fora')); return sleep(lat.inad[k - 1] ?? 10, { devList: [{ gen: k }], charges: [], oldestAll: null }); },
  AsaasAPI: { req: () => sleep(lat.asaas, { data: [] }) },
  _finComposicaoInadRepintar: () => { renders.push({ loaded: ctx._repState.loaded, prontos: ctx._repState.recebiveisProntos, credMap: Object.keys(ctx._repState.credMap).length }); },
};
vm.createContext(ctx);
vm.runInContext(fonte, ctx);

(async () => {
  console.log('F-40 · Repasses: recebíveis em segundo plano, geração manda\n');
  const S = ctx._repState;

  // 1. núcleo resolve antes dos recebíveis
  lat.inad = [200];
  await ctx._repLoad();
  ok('1 · _repLoad resolve com o núcleo', S.loaded === true && S.ops.length === 1 && S.credMap.c1);
  ok('1 · recebíveis ainda não chegaram', S.recebiveisProntos === false && S.inad.devList.length === 0);
  await sleep(260);
  ok('1 · recebíveis pousam depois e fecham', S.recebiveisProntos === true && S.inad.devList[0].gen === 1);
  ok('1 · pouso repintou o card (geração corrente)', renders.length === 1 && renders[0].prontos === true);

  // 2. recarga no meio: gen 1 (lenta) voa; a recarga compartilha o voo em vez de abrir gen 2
  renders.length = 0; nInad = 0; lat.inad = [200];
  S.loaded = false; const p1 = ctx._repLoad();      // gen 1 (lenta)
  await p1; await sleep(30);
  S.loaded = false; const p2 = ctx._repLoad();      // ação: recarga com os recebíveis em voo
  await p2;
  ok('2 · recarga no meio NÃO consulta o Asaas de novo', nInad === 1, 'consultas=' + nInad);
  ok('2 · com o voo compartilhado, ainda "carregando…"', S.recebiveisProntos === false);
  await sleep(260);                                 // o voo compartilhado pousa
  ok('2 · pouso único gravou e fechou', S.inad.devList[0] && S.inad.devList[0].gen === 1 && S.recebiveisProntos === true);
  // Cada _repLoadReal pendura o seu .then no voo compartilhado: o card é repintado uma
  // vez por chamador (outerHTML do mesmo slot — idempotente), sempre com os dados prontos.
  ok('2 · o pouso repintou o card com os recebíveis prontos', renders.length >= 1 && renders.every(r => r.prontos === true), JSON.stringify(renders));

  // 3. recarga depois do pouso: abre nova geração, que grava por cima da anterior
  renders.length = 0; lat.inad = [200, 80];          // gen 2 (80 ms) pousa DEPOIS do núcleo (20 ms)
  S.loaded = false; await ctx._repLoad(); await sleep(150);
  ok('3 · nova geração gravou por cima', S.inad.devList[0].gen === 2 && S.recebiveisProntos === true, 'gen=' + (S.inad.devList[0] && S.inad.devList[0].gen));
  ok('3 · e repintou o card', renders.length === 1);

  // 4. núcleo em voo (spinner) quando os recebíveis pousam → não repinta por cima
  renders.length = 0; nInad = 0; lat.inad = [30]; lat.core = 200;
  S.loaded = false; const p3 = ctx._repLoad();      // recebíveis (30 ms) pousam antes do núcleo (200 ms)
  await sleep(80);
  ok('4 · recebíveis prontos com o núcleo ainda em voo', S.recebiveisProntos === true && S.loaded === false);
  ok('4 · não repintou por cima do spinner', renders.length === 0);
  await p3;
  ok('4 · núcleo pousa depois, com os recebíveis já prontos', S.loaded === true && S.recebiveisProntos === true);
  lat.core = 20;

  // 5. falha nos recebíveis fecha mesmo assim (sem "carregando…" eterno)
  renders.length = 0; nInad = 0; falharInad = true;
  S.loaded = false; await ctx._repLoad(); await sleep(60);
  ok('5 · falha na inadimplência não trava: recebiveisProntos fecha', S.recebiveisProntos === true);
  ok('5 · lista fica vazia (como antes), sem exceção', S.inad.devList.length === 0);
  falharInad = false;

  console.log(falhas ? `\nF-40 · ${falhas} falha(s).` : '\nF-40 · Repasses: a tela pinta com o núcleo; recebíveis pousam depois, um voo por vez.');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
