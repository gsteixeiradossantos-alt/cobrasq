/*
 * Teste F-39 (Financeiro — voo compartilhado nos agregadores).
 *
 * Os agregadores do Financeiro (_finCaixaV2Agg, _finFluxoCarregarBase, _finCascataMetricas,
 * _finRepasseAgg) guardam a promessa em voo NO objeto do cache e só o voo corrente grava.
 * Este teste roda os wrappers reais recortados do index.html, com o leitor por baixo
 * substituído por um contador controlável, e verifica:
 *   1. dois pedidos simultâneos com cache vazio → UMA leitura;
 *   2. `force` durante um voo → o cache termina com o resultado forçado, não com o antigo;
 *   3. troca de período (chave) durante um voo → o cache fica com a chave nova;
 *   4. invalidação (troca do objeto do cache) durante um voo → o voo antigo não grava;
 *   5. leitura que rejeita → solta o voo e propaga o erro; a próxima tenta de novo.
 *
 * Como rodar:
 *   node test/f39_voo_compartilhado.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Os wrappers não têm template literal: o recorte até o primeiro "\n}\n" basta.
function recortaSimples(marca) {
  const ini = HTML.indexOf(marca);
  assert.ok(ini >= 0, `não achei no index.html: ${marca}`);
  const fim = HTML.indexOf('\n}\n', ini);
  assert.ok(fim > ini, `não achei o fim de ${marca}`);
  return HTML.slice(ini, fim + 3);
}

const fonte = [
  'let _finCaixaV2Cache = { at:0, key:"", v:null };',
  'let _finFluxoBaseCache = { at:0, v:null };',
  recortaSimples('async function _finCaixaV2Agg(force){'),
  recortaSimples('async function _finFluxoCarregarBase(force){'),
  // expõe para o teste ler/trocar os caches
  'globalThis.__lerCaixa = () => _finCaixaV2Cache;',
  'globalThis.__trocarCaixa = () => { _finCaixaV2Cache = { at:0, key:"", v:null }; };',
  'globalThis.__lerFluxo = () => _finFluxoBaseCache;',
  'globalThis.__trocarFluxo = () => { _finFluxoBaseCache = { at:0, v:null }; };',
].join('\n\n');

// Leitores controláveis: cada chamada devolve uma promessa que o teste resolve na ordem que quiser.
const pendentes = [];
function leitorControlado(nome) {
  return function () {
    let resolve, reject;
    const p = new Promise((res, rej) => { resolve = res; reject = rej; });
    pendentes.push({ nome, resolve, reject, args: [...arguments] });
    return p;
  };
}
let chaveAtual = 'A';
const ctx = {
  console, Date, Promise, Math, Object,
  _finCascataPeriodoBounds: () => ({ ini: chaveAtual, fim: chaveAtual, nome: chaveAtual }),
  _finCaixaV2AggLer: leitorControlado('caixa'),
  _finFluxoCarregarBaseLer: leitorControlado('fluxo'),
};
vm.createContext(ctx);
vm.runInContext(fonte, ctx);

const tick = () => new Promise(r => setImmediate(r));
let falhas = 0;
function ok(nome, cond, detalhe) {
  if (cond) { console.log(`  ok  ${nome}`); return; }
  falhas++;
  console.log(`  FALHOU  ${nome}${detalhe ? ' — ' + detalhe : ''}`);
}

(async () => {
  console.log('F-39 · voo compartilhado nos agregadores do Financeiro\n');

  // 1. dois pedidos simultâneos → uma leitura
  const p1 = ctx._finCaixaV2Agg(); const p2 = ctx._finCaixaV2Agg();
  await tick();
  ok('1 · dois pedidos, uma leitura', pendentes.filter(x => x.nome === 'caixa').length === 1);
  pendentes.pop().resolve({ n: 1 });
  const [v1, v2] = await Promise.all([p1, p2]);
  ok('1 · os dois recebem o mesmo resultado', v1 === v2 && v1.n === 1);
  ok('1 · cache gravado', ctx.__lerCaixa().v && ctx.__lerCaixa().v.n === 1);

  // 2. force durante um voo: o antigo pousa DEPOIS e não grava por cima
  ctx.__trocarCaixa();
  const pa = ctx._finCaixaV2Agg();            // voo antigo
  await tick();
  const pf = ctx._finCaixaV2Agg(true);        // force: voo novo
  await tick();
  ok('2 · force sobe outro voo', pendentes.length === 2);
  const [antigo, forcado] = pendentes.splice(0, 2);
  forcado.resolve({ n: 'fresco' });
  await pf; await tick();
  ok('2 · o forçado grava', ctx.__lerCaixa().v && ctx.__lerCaixa().v.n === 'fresco');
  antigo.resolve({ n: 'velho' });
  const va = await pa; await tick();
  ok('2 · quem esperava o antigo recebe o dele', va.n === 'velho');
  ok('2 · o antigo NÃO grava por cima do fresco', ctx.__lerCaixa().v.n === 'fresco');

  // 3. troca de período durante um voo: cache termina com a chave nova
  ctx.__trocarCaixa(); chaveAtual = 'A';
  const pA = ctx._finCaixaV2Agg(); await tick();
  chaveAtual = 'B';
  const pB = ctx._finCaixaV2Agg(); await tick();
  ok('3 · chave diferente sobe outro voo', pendentes.length === 2);
  const [vooA, vooB] = pendentes.splice(0, 2);
  vooB.resolve({ n: 'B' }); await pB; await tick();
  vooA.resolve({ n: 'A' }); await pA; await tick();
  const cacheDepois = ctx.__lerCaixa();
  ok('3 · cache com a chave nova, não a antiga', cacheDepois.key === 'B|B' && cacheDepois.v.n === 'B', JSON.stringify(cacheDepois));

  // 4. invalidação (troca do objeto) durante o voo → o voo não grava
  ctx.__trocarFluxo();
  const pFl = ctx._finFluxoCarregarBase(); await tick();
  ctx.__trocarFluxo();                        // alguém gravou e invalidou no meio
  pendentes.pop().resolve({ base: 'antes da escrita' });
  const vFl = await pFl; await tick();
  ok('4 · quem esperava recebe o valor', vFl.base === 'antes da escrita');
  ok('4 · cache continua vazio (voo órfão não grava)', ctx.__lerFluxo().v === null);

  // 5. rejeição solta o voo e propaga; a próxima tenta de novo
  const pErr = ctx._finFluxoCarregarBase(); await tick();
  pendentes.pop().reject(new Error('boom'));
  let erro = null; try { await pErr; } catch (e) { erro = e; }
  ok('5 · erro propaga ao chamador', erro && erro.message === 'boom');
  ok('5 · voo solto', !ctx.__lerFluxo().voo);
  const pDeNovo = ctx._finFluxoCarregarBase(); await tick();
  ok('5 · próxima chamada lê de novo', pendentes.length === 1);
  pendentes.pop().resolve({ base: 'ok' }); await pDeNovo; await tick();
  ok('5 · e grava', ctx.__lerFluxo().v && ctx.__lerFluxo().v.base === 'ok');

  console.log(falhas ? `\nF-39 · ${falhas} falha(s).` : '\nF-39 · voo compartilhado: uma leitura por vez, só o voo corrente grava.');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
