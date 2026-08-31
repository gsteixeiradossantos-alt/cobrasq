/*
 * Teste F-14 — duas funções com o MESMO nome no mesmo escopo.
 *
 * Em JavaScript a última declaração vence, em silêncio. Foi assim que o "Mudar
 * categoria" da aba Judicial quebrou em 31/08/2026: eu criei
 * `alterarCategoriaLote` sem procurar antes, e JÁ EXISTIA uma com esse nome usada
 * pelo lote de Movimentações. A minha ficou morta; rodou a antiga — que não devolve
 * nada — e o `r.pulados` estourou "Cannot read properties of undefined". Pior: a
 * antiga apaga o rateio e reinsere, então ela ESCREVEU antes do erro aparecer.
 *
 * Nada disso é pego por lint, teste de unidade ou revisão de diff: as duas
 * declarações estão a 60 linhas de distância, num arquivo de 50 mil.
 *
 * Esta guarda varre as declarações de função de topo do index.html e falha quando
 * um nome aparece duas vezes. A lista abaixo é a linha de base do que JÁ estava
 * duplicado antes — não é absolvição: são bugs conhecidos, descritos um a um.
 *
 * Como rodar:
 *   node test/f14_sem_funcao_duplicada.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Colisões que já existiam em 31/08/2026, com o efeito de cada uma. Consertar exige
// decidir qual das duas fica — não é mecânico, e não cabia no PR que achou isto.
const CONHECIDAS = {
  // 31768 (opId, patch, msg) é engolida por 31807 (i). Os três chamadores da fila
  // ("sem repasse", "repasse confirmado", "vincular credor") passam um uuid onde a
  // sobrevivente espera um índice: `itens[uuid]` é undefined e ela retorna calada.
  _finFilaResolver: 2,
  // 43781 (clienteId) é engolida por 48055 (devId). O botão "Vincular do ZapSign"
  // da ficha de CLIENTE abre o fluxo de DEVEDOR com um id de cliente.
  abrirVincularZapSign: 2,
};

let falhas = 0;
function ok(nome, cond, detalhe) {
  if (cond) { console.log(`  ok  ${nome}`); return; }
  falhas++; console.error(`  FALHOU  ${nome}${detalhe ? ' — ' + detalhe : ''}`);
}

console.log('\nF-14 · nenhuma função declarada duas vezes\n');

// Só declarações no início da linha: `function x(` e `async function x(`. Métodos de
// objeto e funções aninhadas em outro escopo não entram — o que interessa é a colisão
// de topo, que é a que apaga uma das duas.
const nomes = {};
for (const m of HTML.matchAll(/^[ \t]*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
  nomes[m[1]] = (nomes[m[1]] || 0) + 1;
}

const duplicadas = Object.entries(nomes).filter(([, n]) => n > 1)
  .map(([nome, n]) => ({ nome, n }));

// `confirmarRecebimentoJudicial` aparece 2x mas em ESCOPOS diferentes (uma dentro do
// módulo finApi, que fecha antes da outra) — não colidem. Conferido em 31/08.
const ESCOPOS_DIFERENTES = new Set(['confirmarRecebimentoJudicial']);

const novas = duplicadas.filter(d => !(d.nome in CONHECIDAS) && !ESCOPOS_DIFERENTES.has(d.nome));
ok('nenhuma colisão de nome NOVA',
  novas.length === 0,
  'duplicadas: ' + novas.map(d => `${d.nome} (${d.n}×)`).join(', ') +
  ' — a última declaração vence e a outra vira código morto');

for (const [nome, n] of Object.entries(CONHECIDAS)) {
  const atual = nomes[nome] || 0;
  ok(`${nome}: colisão conhecida não piorou (${atual}× de ${n})`, atual <= n,
    'ganhou mais uma declaração ainda');
}

// A que causou o incidente: uma definição e uma chave no export.
ok('alterarCategoriaLote tem UMA definição', (nomes.alterarCategoriaLote || 0) === 1,
  'voltou a existir duas — a de cima vira código morto e a de baixo é que roda');
const chaves = (HTML.match(/^\s*alterarCategoriaLote,\s*$/gm) || []).length;
ok('e UMA chave no export do finApi', chaves === 1,
  `${chaves} chaves — chave repetida em objeto literal também é silenciosa`);

// E o contrato que o incidente expôs: quem chama tem de aguentar retorno sem pulados.
const jud = HTML.slice(HTML.indexOf('async function _finJudLote(acao){'));
ok('o caller da Judicial não confia cegamente no retorno',
  /r && r\.pulados/.test(jud.slice(0, 2000)),
  'volta a estourar "Cannot read properties of undefined (reading \'pulados\')"');

console.log('');
if (falhas) { console.error(`${falhas} falha(s).`); process.exit(1); }
console.log('F-14 · nenhuma função declarada duas vezes.');
