/*
 * Teste F-11 — a marca do pente-fino não cega quem LÊ a descrição do lançamento.
 *
 * Em 31/08/2026 as 1.448 descrições de `fin_lancamento` receberam o sufixo
 * ` · verificar`: o Gustavo está conferindo lançamento por lançamento e apaga a marca
 * conforme confere. A marca encolhendo é o progresso dele.
 *
 * O efeito colateral: TODO leitor da descrição é ancorado no FIM, porque é lá que a
 * numeração de parcela mora (` 59/60`). A marca ficou depois dela e cegou os quatro:
 *
 *   · _fincrSerieChave  — 436 lançamentos sem `cobranca_id` viraram um grupo POR PARCELA
 *                         em "Recebíveis e repasses", em vez de uma série só;
 *   · _fincrSerieNome   — o nome exibido virou "Noeli Rodrigues da Rosa 59/60 · verificar";
 *   · _finEdNumeracao   — o editor parou de reconhecer a numeração (devolvia null);
 *   · api/_repassar.js  — o `like` que propaga o credor às outras parcelas parou de casar.
 *
 * O caso que mais importa é o MISTO: enquanto ele confere, a mesma série tem parcela com
 * marca e parcela sem. As duas precisam continuar no mesmo grupo, senão a tela se parte
 * ao meio no meio do trabalho dele.
 *
 * Como rodar:
 *   node test/f11_marca_pente_fino.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');

// Extrai o bloco do helper até o fim de _finEdNumeracao — é contíguo no arquivo.
function trecho(de, ate, incluirFim = true) {
  const i = HTML.indexOf(de);
  assert.ok(i >= 0, `não achei no index.html: ${de}`);
  const j = HTML.indexOf(ate, i + de.length);
  assert.ok(j > i, `não achei o fim (${ate}) a partir de ${de}`);
  return HTML.slice(i, incluirFim ? j + ate.length : j);
}

// `const` dentro do vm fica no escopo léxico do script e NÃO vira propriedade do
// contexto — por isso tudo roda num script só, que no fim exporta o que o teste usa.
const fonte = [
  trecho('const FIN_MARCA_PENTE', 'function _finEdNumeracao(desc){', false),
  trecho('function _finEdNumeracao(desc){', '\n}'),
  trecho('const _fincrSerieChave', '\n'),
  trecho('const _fincrSerieNome', '\n'),
  'this._finEdNumeracao = _finEdNumeracao;',
  'this._fincrSerieChave = _fincrSerieChave;',
  'this._fincrSerieNome = _fincrSerieNome;',
  'this._finDescCrua = _finDescCrua;',
].join('\n');
const ctx = { console, String, Number, Object, Array, RegExp, Set };
vm.createContext(ctx);
vm.runInContext(fonte, ctx);

let falhas = 0;
function ok(nome, cond, detalhe) {
  if (cond) { console.log(`  ok  ${nome}`); return; }
  falhas++; console.log(`  FALHOU  ${nome}${detalhe ? ' — ' + detalhe : ''}`);
}

console.log('\nF-11 · marca do pente-fino × leitores da descrição\n');

const L = (desc, cobranca_id = null) => ({ descricao: desc, cobranca_id });
const grupos = rows => new Set(rows.map(ctx._fincrSerieChave)).size;

// ── Agrupamento da série ────────────────────────────────────────────────────
ok('série marcada continua UM grupo',
  grupos([L('Noeli Rodrigues da Rosa 59/60 · verificar'),
          L('Noeli Rodrigues da Rosa 60/60 · verificar')]) === 1,
  'a marca voltou a partir a série em um grupo por parcela');

ok('série MISTA (uma conferida, outra não) continua UM grupo',
  grupos([L('Noeli Rodrigues da Rosa 59/60'),
          L('Noeli Rodrigues da Rosa 60/60 · verificar')]) === 1,
  'a tela se parte ao meio enquanto ele confere');

ok('séries de devedores DIFERENTES seguem separadas',
  grupos([L('Noeli Rodrigues da Rosa 1/60 · verificar'),
          L('Terezinha Pinheiro 1/57 · verificar')]) === 2,
  'agrupou gente diferente no mesmo balde');

ok('nome da série sai limpo, sem numeração e sem marca',
  ctx._fincrSerieNome(L('Noeli Rodrigues da Rosa 59/60 · verificar')) === 'Noeli Rodrigues da Rosa');

// ── Editor: numeração de parcela ────────────────────────────────────────────
const comMarca = ctx._finEdNumeracao('Noeli Rodrigues da Rosa 60/60 · verificar');
const semMarca = ctx._finEdNumeracao('Noeli Rodrigues da Rosa 60/60');
ok('editor reconhece a numeração COM a marca', !!comMarca && comMarca.n === 60 && comMarca.total === 60,
  'devolveu ' + JSON.stringify(comMarca));
ok('e devolve o mesmo que devolveria sem ela',
  !!semMarca && comMarca && comMarca.base === semMarca.base && comMarca.n === semMarca.n);

ok('formato com parênteses também', (r => r && r.n === 3 && r.total === 12 && r.base === 'Fulano')
  (ctx._finEdNumeracao('Fulano (3/12) · verificar')));
ok('formato com prefixo "Parcela N/T" também', (r => r && r.n === 3 && r.total === 12)
  (ctx._finEdNumeracao('Parcela 3/12 · Fulano · verificar')));

// ── Não pode comer texto legítimo ───────────────────────────────────────────
// A marca só vale no FIM. "verificar" no meio da frase é palavra da descrição.
const meio = ctx._finEdNumeracao('Honorário verificar de contas 2/3');
ok('"verificar" no MEIO da descrição é preservado',
  !!meio && meio.base === 'Honorário verificar de contas',
  'devolveu base ' + JSON.stringify(meio && meio.base));

ok('descrição que termina em "verificar" SEM o ponto não é tocada',
  ctx._fincrSerieNome(L('Pendência a verificar')) === 'Pendência a verificar');

// ── Guarda de fonte: o backend recebeu o mesmo tratamento ───────────────────
const REPASSAR = fs.readFileSync(path.join(RAIZ, 'api', '_repassar.js'), 'utf8');
// Não basta o arquivo "citar" verificar: a marca tem de ser tirada ANTES do corte da
// numeração, senão o `like` continua não casando. Extrai a expressão real e roda.
const mBase = REPASSAR.match(/const base = String\(lanc\.descricao \|\| ''\)([\s\S]{0,220}?)\.trim\(\);/);
ok('api/_repassar.js monta a base cortando marca E numeração', !!mBase,
  'a expressão que monta `base` mudou de forma — reveja este teste junto');
if (mBase) {
  const base = new Function('lanc', `const base = String(lanc.descricao || '')${mBase[1]}.trim(); return base;`);
  ok('base do `like` ignora a marca (propaga o credor às outras parcelas)',
    base({ descricao: 'Noeli Rodrigues da Rosa 59/60 · verificar' }) === 'Noeli Rodrigues da Rosa',
    'devolveu ' + JSON.stringify(base({ descricao: 'Noeli Rodrigues da Rosa 59/60 · verificar' })));
  ok('e continua certa para quem já foi conferido',
    base({ descricao: 'Noeli Rodrigues da Rosa 59/60' }) === 'Noeli Rodrigues da Rosa');
}

console.log('');
if (falhas) { console.error(`${falhas} falha(s).`); process.exit(1); }
console.log('F-11 · a marca do pente-fino não cega os leitores da descrição.');
