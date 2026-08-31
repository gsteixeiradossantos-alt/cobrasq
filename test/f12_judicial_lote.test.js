/*
 * Teste F-12 — aba Judicial: seleção em lote, numeração da parcela e os estilos que
 * a aba não carregava.
 *
 * Tudo veio de um print do Gustavo em 31/08/2026, olhando a Terezinha Pinheiro:
 *
 *  1. não havia seletor para conferir o total de um processo contra os autos;
 *  2. a coluna de parcela mostrava "—" (as colunas numero_parcela/total_parcelas estão
 *     VAZIAS nos 122 judiciais; a numeração só existe dentro da descrição);
 *  3. o polegar e o kebab estavam "diferentes do normal" — porque `.finmv-pol` e
 *     `.finmv-kebab` são definidos no <style> que vive DENTRO do render de
 *     Movimentações, e a aba Judicial troca todo o #fin-content. Os botões caíam no
 *     <button> cru.
 *
 * A soma da barra é o ponto sensível: ela precisa ignorar id selecionado que já não
 * está mais na lista (parcela liberada ou excluída entre um render e outro), senão
 * anuncia um total que não corresponde a nada na tela.
 *
 * Como rodar:
 *   node test/f12_judicial_lote.test.js
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

console.log('\nF-12 · aba Judicial: lote, parcela e estilo\n');

// A barra usa fmtR/escHtml/isoLocal do app — stubs bastam para medir a MATEMÁTICA.
const ctxVm = {
  console, String, Number, Object, Array, Set, Math, RegExp,
  fmtR: n => 'R$ ' + Number(n).toFixed(2).replace('.', ','),
  escHtml: x => String(x == null ? '' : x),
  isoLocal: () => '2026-08-31',
  _finJudRender: () => {},
};
vm.createContext(ctxVm);
vm.runInContext([
  trecho('let _finJudState =', '\n'),
  trecho('function _finJudSelToggle(id){', '\n}'),
  trecho('function _finJudSelGrupo(idsCsv, marcar){', '\n}'),
  trecho('function _finJudLoteBarraHtml(ctx){', '\n}'),
  'this._finJudState = _finJudState;',
  'this._finJudSelToggle = _finJudSelToggle;',
  'this._finJudSelGrupo = _finJudSelGrupo;',
  'this._finJudLoteBarraHtml = _finJudLoteBarraHtml;',
].join('\n'), ctxVm);

const linha = (id, valor) => ({ id, valor, descricao: `X ${id}/40 · verificar` });
const CTX = {
  pendentes: [linha(1, 98.08), linha(2, 98.08), linha(3, 148.52)],
  dim: { contas: [{ id: 9, descricao: 'Conta Principal' }] },
};
const qt = h => (h.match(/class="qt">([^<]+)/) || [])[1] || '';
const tt = h => (h.match(/class="tt">([^<]+)/) || [])[1] || '';

ctxVm._finJudState.sel = new Set();
ok('sem seleção a barra não existe', ctxVm._finJudLoteBarraHtml(CTX) === '',
  'barra fixa cobrindo o rodapé sem nada selecionado');

ctxVm._finJudSelToggle(1); ctxVm._finJudSelToggle(3);
let h = ctxVm._finJudLoteBarraHtml(CTX);
ok('soma de 2 selecionados', tt(h) === 'R$ 246,60', 'somou ' + tt(h));
ok('conta no singular/plural certo', qt(h) === '2 valores selecionados', qt(h));

ctxVm._finJudSelGrupo('1,2,3', true);
h = ctxVm._finJudLoteBarraHtml(CTX);
ok('marcar o grupo inteiro soma tudo', tt(h) === 'R$ 344,68', 'somou ' + tt(h));

ctxVm._finJudSelGrupo('1,2,3', false);
ok('desmarcar o grupo esvazia a barra', ctxVm._finJudLoteBarraHtml(CTX) === '');

// O ponto sensível.
ctxVm._finJudState.sel = new Set([1, 999]);
h = ctxVm._finJudLoteBarraHtml(CTX);
ok('id que saiu da lista é ignorado (não infla o total)',
  qt(h) === '1 valor selecionado' && tt(h) === 'R$ 98,08',
  `${qt(h)} / ${tt(h)}`);

ctxVm._finJudState.sel = new Set([1]);
h = ctxVm._finJudLoteBarraHtml(CTX);
ok('singular quando é um só', qt(h) === '1 valor selecionado', qt(h));

// ── Guardas de fonte ────────────────────────────────────────────────────────
const styles = [...HTML.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]);
const cssJud = styles.find(b => b.includes('.finjd-row{'));
ok('o <style> da aba Judicial existe', !!cssJud);
for (const cls of ['.finmv-pol', '.finmv-kebab', '.finmv-cel', '.finmv-pop', '.finmv-menu']) {
  ok(`${cls} definido na aba Judicial (senão o botão vira <button> cru)`,
    !!cssJud && cssJud.includes(cls),
    'o CSS de Movimentações não alcança esta aba — ela troca todo o #fin-content');
}
ok('a linha da Judicial tem coluna para o checkbox',
  !!cssJud && /\.finjd-row\{[^}]*grid-template-columns:\s*22px\s+46px/.test(cssJud),
  'sem a coluna, o checkbox empurra o resto do grid');

const rowHtml = trecho('function _finJudRowHtml(r, g, ctx){', '\n}');
ok('a linha lê a numeração da descrição quando a coluna está vazia',
  rowHtml.includes('_finSerieNum(r.descricao)'),
  'volta a mostrar "—" nos 122 judiciais');
ok('a linha tem checkbox', rowHtml.includes('_finJudSelToggle('));
ok('o cabeçalho do grupo tem "marcar todas"',
  trecho('function _finJudGrupoHtml(g, ctx){', '\n}').includes('_finJudSelGrupo('));

const lote = trecho('async function _finJudLote(acao){', '\n}');
ok('o lote de recebimento confirma antes de mover dinheiro', /confirm\(/.test(lote),
  'marcar recebido em lote tira da Judicial e joga no caixa — sem confirmação, não');
ok('o lote de exclusão também confirma', (lote.match(/confirm\(/g) || []).length >= 2);

console.log('');
if (falhas) { console.error(`${falhas} falha(s).`); process.exit(1); }
console.log('F-12 · lote, numeração e estilo da aba Judicial.');
