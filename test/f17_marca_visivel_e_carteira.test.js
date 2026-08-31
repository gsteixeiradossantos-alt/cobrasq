/*
 * Teste F-17 — a marca do pente-fino é VISÍVEL, e a receita diz de quem é a carteira.
 *
 * Duas coisas que a Sthefany Gabrielli Pereira Allebrandt revelou em 31/08/2026.
 *
 * 1. A marca ` · verificar` sumiu da tela. O #609 criou `_finDescCrua` para os LEITORES
 *    da descrição — série, numeração, pareamento do repasse —, que eram cegados pela
 *    marca. Só que ela foi aplicada também ao texto EXIBIDO, e aí apagou da tela o
 *    progresso do Gustavo: ele apaga a marca conforme confere cada lançamento, e sem
 *    vê-la não há como saber o que falta. Ela só reaparecia no tooltip.
 *
 * 2. A receita nunca dizia de quem era a carteira. O mapa que resolve o credor pela
 *    cobrança rodava só para as SAÍDAS — foi escrito para os repasses e nunca estendido.
 *    As 13 parcelas da Sthefany apontam para Arte Estofados Decor pela cobrança, e a tela
 *    não dizia de nenhuma delas, enquanto as 10 despesas de repasse do MESMO caso diziam.
 *
 * O perigo do conserto 2 é o motivo principal deste teste: `_finLancEhRepasse` tem como
 * terceira origem "está no mapa de credor". Estender o mapa às receitas sem filtrar por
 * tipo faria TODA receita com cobrança virar "a repassar", e o chip passaria a contar as
 * entradas junto com os repasses.
 *
 * Como rodar:
 *   node test/f17_marca_visivel_e_carteira.test.js
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

const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  corta('const FIN_MARCA_PENTE', '\n') + corta('const _finDescCrua', '\n')
  + corta('function _finMovDescSemParcela(l){', '\n}')
  + // `_finEhTarifa` (F-18) é usado por _finLancEhRepasse e pelo escopo do lastro.
  corta('const _finEhTarifa', '\n') + '\n'
  + corta('function _finRepasseTemLastroApuravel(l){', '\n}')
  + corta('function _finLancEhRepasse(l, ctx){', '\n}')
  + corta('function _finLancCedente(l, ctx){', '\n}')
  + 'this._desc = _finMovDescSemParcela; this._ehRepasse = _finLancEhRepasse; this._cedente = _finLancCedente;',
  ctx
);
const desc = ctx._desc, ehRepasse = ctx._ehRepasse, cedente = ctx._cedente;

// ── 1. A marca aparece no texto exibido ────────────────────────────────────────────
assert.strictEqual(
  desc({ descricao: 'Sthefany Gabrielli Pereira Allebrandt 2/13 · verificar', numero_parcela: 2, total_parcelas: 13 }),
  'Sthefany Gabrielli Pereira Allebrandt · verificar',
  'a numeração vira etiqueta, mas a marca do pente-fino tem de continuar visível');

// Sem a marca no banco, nada é acrescentado — a marca não pode ser inventada.
assert.strictEqual(
  desc({ descricao: 'Leonardo dos Santos Fortes 13/15', numero_parcela: 13, total_parcelas: 15 }),
  'Leonardo dos Santos Fortes',
  'lançamento já conferido não pode voltar a exibir a marca');

// Sem numeração nas colunas, o texto sai inteiro — e ainda com a marca.
assert.strictEqual(
  desc({ descricao: 'Sthefany Gabrielli Pereira Allebrandt · verificar' }),
  'Sthefany Gabrielli Pereira Allebrandt · verificar');

// Descrição vazia continua virando travessão, não " · verificar" solto.
assert.strictEqual(desc({ descricao: '' }), '—');

// ── 2. A receita diz de quem é a carteira ──────────────────────────────────────────
const RECEITA = { id: 123951, tipo_movimento: 1, status: 0, credor_id: null,
                  descricao: 'Sthefany Gabrielli Pereira Allebrandt 2/13 · verificar' };
const ctxTela = { opsByLanc: {}, cedMap: {}, credorPorLanc: { 123951: 'Arte Estofados Decor Ltda' } };
assert.strictEqual(cedente(RECEITA, ctxTela), 'Arte Estofados Decor Ltda',
  'a receita tem de dizer de quem é a carteira quando a cobrança sabe');

// ── 3. …e NÃO vira "a repassar" por causa disso ────────────────────────────────────
// Este é o perigo do conserto 2: sem o filtro por tipo, toda receita com cobrança
// entraria no chip "A repassar" junto com os repasses de verdade.
assert.strictEqual(ehRepasse(RECEITA, ctxTela), false,
  'receita com carteira conhecida NÃO é dinheiro a repassar');

// A saída continua sendo, pelo mesmo mapa — a regra antiga não pode ter se perdido.
const SAIDA = { id: 125164, tipo_movimento: 0, status: 0, credor_id: 'arte',
                descricao: 'Sthefany Gabrielli Pereira Allebrandt 1/10 · verificar' };
assert.strictEqual(
  ehRepasse(SAIDA, { opsByLanc: {}, cedMap: {}, credorPorLanc: { 125164: 'Arte Estofados Decor Ltda' } }),
  true, 'a saída de repasse continua contando pelo mapa de credor');

// ── 4. O filtro por tipo está escrito, não implícito ───────────────────────────────
const fonte = corta('function _finLancEhRepasse(l, ctx){', '\n}');
assert.ok(/l\.tipo_movimento\s*===\s*0\s*&&[\s\S]*credorPorLanc/.test(fonte),
  'a terceira origem precisa filtrar por saída explicitamente');

// ── 5. A carteira é montada para os DOIS tipos ─────────────────────────────────────
assert.ok(HTML.includes('const saidas = rows.filter(r=>!opsByLanc[r.id] && (r.credor_id || r.cobranca_id));'),
  'o mapa de carteira não pode voltar a filtrar só tipo_movimento===0');

console.log('F-17 ok — marca visível na linha, e a receita diz a carteira sem virar repasse.');
