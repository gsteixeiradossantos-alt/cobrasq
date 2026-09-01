/*
 * Teste F-16 — as três ações nomeadas da Fila gravam mesmo.
 *
 * De 27/08 a 31/08/2026 elas não gravaram nada. A função que elas chamavam,
 * `_finFilaResolver(opId, patch, msg)`, tinha o MESMO NOME de outra logo abaixo —
 * `_finFilaResolver(i)`, a do botão "Resolver ⏎", que resolve pelo ÍNDICE. Duas
 * declarações no mesmo escopo: a de baixo vence. As três passavam um uuid onde a
 * sobrevivente esperava um índice; `itens[uuid]` é undefined e ela retornava calada.
 *
 * Medido contra produção em 31/08, com o Supabase interceptado: ZERO gravações e
 * NENHUMA mensagem — o clique não deixava rastro. 44 operações seguem em "revisar",
 * a mais antiga de 10/07.
 *
 * A colisão foi desfeita renomeando a genérica para `_finFilaAplicarPatch`. Este
 * teste executa as três de verdade, com o banco falso, e confere o patch de cada uma.
 *
 * Como rodar:
 *   node test/f16_fila_acoes.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');

function trecho(de, ate, incluirFim = true) {
  const i = HTML.indexOf(de);
  assert.ok(i >= 0, `não achei no index.html: ${de}`);
  const j = HTML.indexOf(ate, i + de.length);
  assert.ok(j > i, `não achei o fim (${ate}) a partir de ${de}`);
  return HTML.slice(i, incluirFim ? j + ate.length : j);
}

let falhas = 0;
function ok(nome, cond, detalhe) {
  if (cond) { console.log(`  ok  ${nome}`); return; }
  falhas++; console.error(`  FALHOU  ${nome}${detalhe ? ' — ' + detalhe : ''}`);
}

console.log('\nF-16 · as três ações da Fila gravam\n');

const gravacoes = [];
const avisos = [];
const ctx = {
  console, String, Number, Object, Array, Promise, JSON,
  confirm: () => true,
  showToast: (m) => avisos.push(m),
  renderFinTab: () => {},
  getSupabase: () => ({
    from: (t) => ({
      update: (patch) => ({ eq: (_c, id) => { gravacoes.push({ tabela: t, patch, id }); return Promise.resolve({ error: null }); } }),
      select: () => ({ limit: () => Promise.resolve({ data: [{ id: 'cli-9', nome: 'Arte Estofados', nome_fantasia: null }] }) }),
    }),
  }),
};
vm.createContext(ctx);
vm.runInContext([
  'let _finFilaState = { resolvidosHoje: 0, itens: [] };',
  'let _finCascataCache = {}, _finRepasseAggCache = {};',
  trecho('async function _finFilaSemRepasse(opId){', '\n}'),
  trecho('async function _finFilaConfirmarRepasseExistente(opId){', '\n}'),
  trecho('async function _finFilaAdotarCedenteDoRepasse(opId){', '\n}'),
  trecho('async function _finFilaAplicarPatch(opId, patch, msg){', '\n}'),
  'this.__set = (s) => { _finFilaState = s; };',
  'this._finFilaSemRepasse = _finFilaSemRepasse;',
  'this._finFilaConfirmarRepasseExistente = _finFilaConfirmarRepasseExistente;',
  'this._finFilaAdotarCedenteDoRepasse = _finFilaAdotarCedenteDoRepasse;',
].join('\n'), ctx);

const OP = 'uuid-op-123';
ctx.__set({ resolvidosHoje: 0, itens: [{ op: { id: OP }, rep: { n: 2, credorNome: 'Arte Estofados' } }] });

(async () => {
  gravacoes.length = 0;
  await ctx._finFilaSemRepasse(OP);
  const g1 = gravacoes[0];
  ok('"Marcar como sem repasse" grava', !!g1, 'não gravou nada — foi o defeito de 27/08');
  ok('  … em fin_operacao, no id certo', g1 && g1.tabela === 'fin_operacao' && g1.id === OP);
  ok('  … com repasse_status=nao_aplica e capital zerado',
    g1 && g1.patch.repasse_status === 'nao_aplica' && g1.patch.valor_capital === 0,
    JSON.stringify(g1 && g1.patch));

  gravacoes.length = 0;
  await ctx._finFilaConfirmarRepasseExistente(OP);
  const g2 = gravacoes[0];
  ok('"Confirmar e tirar da fila" grava', !!g2);
  ok('  … com repasse_status=efetuado e SEM mexer em valor',
    g2 && g2.patch.repasse_status === 'efetuado' && !('valor_capital' in g2.patch),
    'zerar capital aqui apagaria o valor de um repasse que já foi lançado');

  gravacoes.length = 0;
  await ctx._finFilaAdotarCedenteDoRepasse(OP);
  const g3 = gravacoes[0];
  ok('"Usar {credor}" grava', !!g3);
  ok('  … vinculando o credor achado no cadastro',
    g3 && g3.patch.credor_id === 'cli-9' && g3.patch.repasse_status === 'efetuado',
    JSON.stringify(g3 && g3.patch));

  // Guarda de fonte: a colisão que causou tudo isso não pode voltar.
  const defs = (HTML.match(/^[ \t]*(?:async\s+)?function\s+_finFilaResolver\s*\(/gm) || []).length;
  ok('_finFilaResolver tem UMA definição só', defs === 1,
    `${defs} definições — a de baixo vence e a de cima vira código morto`);
  ok('as três ações NÃO chamam mais _finFilaResolver',
    !/await _finFilaResolver\(opId/.test(HTML),
    'voltaram a cair na função de índice e a sumir em silêncio');
  ok('o botão "Resolver ⏎" continua na função de índice',
    /_finFilaResolver\(\$\{i\}\)/.test(HTML),
    'o caminho que FUNCIONAVA foi quebrado junto');

  console.log('');
  if (falhas) { console.error(`${falhas} falha(s).`); process.exit(1); }
  console.log('F-16 · as três ações da Fila gravam.');
})();
