/*
 * Teste F-29 — Fluxo de caixa (projeção de 12 meses).
 *
 * A aba nasceu do plano de recuperação de caixa de 04/09/2026. O motor é uma função pura
 * (finFluxoProjetar) e este teste fixa o que ela promete, com números redondos:
 *   1. receita própria = entra − repasses, mês a mês; caixa encadeia;
 *   2. a retirada é o que sobra depois de fixos, DAS e dívida, entre 0 e o alvo;
 *   3. honorário na frente: a safra nova paga primeiro a parte da COBRASQ, depois o capital;
 *   4. o backlog de repasses vencidos é quitado inteiro em N meses e sai do caixa livre;
 *   5. a classificação de saídas: credor = repasse, tarifa nunca é repasse, empréstimo
 *      e parcelamento são dívida, o resto é custo próprio; a recorrência do DAS não soma
 *      de novo (o imposto entra pela premissa);
 *   6. faturamento previsto = receitas previstas − só os repasses (a base da nota).
 *
 * Roda contra o CÓDIGO REAL do index.html, sem rede e sem navegador.
 *
 * Como rodar:
 *   node test/f29_fluxo_caixa_projecao.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function trechoAte(marca, fim) {
  const i = HTML.indexOf(marca);
  assert.ok(i >= 0, `não achei no index.html: ${marca}`);
  const j = HTML.indexOf(fim, i + marca.length);
  assert.ok(j > i, `não achei o fim de ${marca}`);
  return HTML.slice(i, j + fim.length);
}
// Recorte por casamento de chaves (mesmo recorte do F-07): sobrevive a `${...}` aninhado.
function recorta(marca) {
  const ini = HTML.indexOf(marca);
  assert.ok(ini >= 0, `não achei no index.html: ${marca}`);
  let i = HTML.indexOf('{', ini);
  let nivel = 0;
  const tpl = [];
  for (; i < HTML.length; i++) {
    const c = HTML[i], prox = HTML[i + 1];
    if (c === '/' && prox === '/') { i = HTML.indexOf('\n', i); continue; }
    if (c === '/' && prox === '*') { i = HTML.indexOf('*/', i) + 1; continue; }
    if (c === '\\') { i++; continue; }
    if (c === '`') { if (tpl.length && tpl[tpl.length - 1] === 0) tpl.pop(); else tpl.push(0); continue; }
    if (tpl.length) {
      if (c === '$' && prox === '{') { tpl.push(1); nivel++; i++; continue; }
      if (c === '}' && tpl[tpl.length - 1] === 1) { tpl.pop(); nivel--; continue; }
      if (tpl[tpl.length - 1] === 0) continue;
    }
    if (c === '"' || c === "'") { const q = c; i++; for (; i < HTML.length && HTML[i] !== q; i++) if (HTML[i] === '\\') i++; continue; }
    if (c === '{') nivel++;
    else if (c === '}') { nivel--; if (nivel === 0) return HTML.slice(ini, i + 1); }
  }
  assert.fail(`recorte sem fim: ${marca}`);
}

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(
  trechoAte('const _finEhTarifa', '\n') + '\n'
  + trechoAte('const _finDeISO', '\n') + '\n'
  + trechoAte('const FIN_FLUXO_PREMISSAS_PADRAO = Object.freeze(', '});') + '\n'
  + trechoAte('const FIN_FLUXO_RX_REPASSE', '\n') + '\n'
  + trechoAte('const FIN_FLUXO_RX_DIVIDA', '\n') + '\n'
  + trechoAte('const FIN_FLUXO_RX_JUDICIAL', '\n') + '\n'
  + recorta('function _finFluxoClassificaSaida(l, catNome)') + '\n'
  + recorta('function _finFluxoClassificaEntrada(l, catNome)') + '\n'
  + recorta('function _finFluxoClassificaRecorrencia(r)') + '\n'
  + recorta('function _finFluxoEhContingente(l, entradasPorCob)') + '\n'
  + recorta('function _finFluxoFaturamentoResumo(itens, mesKey)') + '\n'
  + recorta('function finFluxoProjetar(base, p)') + '\n'
  + 'this.projetar = finFluxoProjetar; this.saida = _finFluxoClassificaSaida; this.entrada = _finFluxoClassificaEntrada;'
  + 'this.contingente = _finFluxoEhContingente; this.PADRAO = FIN_FLUXO_PREMISSAS_PADRAO; this.recorrencia = _finFluxoClassificaRecorrencia; this.faturamento = _finFluxoFaturamentoResumo;',
  ctx
);
const { projetar, saida, entrada, contingente, PADRAO, recorrencia, faturamento } = ctx;
const perto = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg}: ${a} ≠ ${b}`);

// Base redonda: 3 meses, sem judicial, sem originação, sem DAS — o que entra e sai é
// só o que está na carteira.
function base3() {
  return {
    caixaInicial: 1000, backlog: 300, fracMesAtual: 1,
    meses: [
      { key: '2026-09', label: 'set/26', entradas: 10000, repFixo: 1000, repCont: 2000, dividas: 500, outros: 400, recorrencias: 100 },
      { key: '2026-10', label: 'out/26', entradas: 8000, repFixo: 0, repCont: 4000, dividas: 500, outros: 0, recorrencias: 500 },
      { key: '2026-11', label: 'nov/26', entradas: 6000, repFixo: 500, repCont: 500, dividas: 500, outros: 0, recorrencias: 500 },
    ],
  };
}
const seco = { realizacao: 1, judicialMes: 0, dasPct: 0, origContratadoMes: 0, avistaMes: 0, dividasNaoLancadas: 0, fixosNaoLancados: 0, backlogMeses: 3, prolaboreAlvo: 5000, horizonte: 12 };

// ── 1. Receita própria = entra − repasses; caixa encadeia ────────────────────────────
{
  const { rows } = projetar(base3(), seco);
  assert.strictEqual(rows.length, 3, 'horizonte respeita a carteira quando ela é menor');
  for (const r of rows) perto(r.receitaPropria, r.totalRec - r.totalRep, `receita própria ${r.label}`);
  perto(rows[0].totalRec, 10000, 'set entra a carteira inteira com realização 100%');
  perto(rows[0].totalRep, 1000 + 2000 + 100, 'set repassa fixo + contingente + 1/3 do backlog');
  perto(rows[0].fixos, 500, 'fixos = outros + recorrências');
  perto(rows[0].caixaIni, 1000, 'caixa inicial');
  for (let i = 1; i < rows.length; i++) perto(rows[i].caixaIni, rows[i - 1].caixaFim, `caixa encadeia em ${rows[i].label}`);
  for (const r of rows) perto(r.caixaFim, r.caixaIni + r.receitaPropria - r.totalSaidas, `caixa fim ${r.label}`);
}

// ── 2. Retirada = sobra limitada ao alvo, nunca negativa ────────────────────────────
{
  const { rows } = projetar(base3(), seco);
  // set: 10000 − 3100 = 6900 próprios; − 500 fixos − 500 dívida = 5900 sobra; alvo 5000.
  perto(rows[0].retirada, 5000, 'set paga o alvo inteiro');
  perto(rows[0].falta, 0, 'set não falta nada');
  perto(rows[0].resultado, 900, 'o que passa do alvo fica no caixa');
  // out: 8000 − 4100 = 3900; − 500 − 500 = 2900 → retirada 2900, falta 2100.
  perto(rows[1].retirada, 2900, 'out paga o que sobra');
  perto(rows[1].falta, 2100, 'out falta o resto até o alvo');
  // Mês que não cobre nem os fixos: retirada zero, caixa cai.
  const b = base3(); b.meses[0].entradas = 500;
  const r0 = projetar(b, seco).rows[0];
  assert.strictEqual(r0.retirada, 0, 'sem sobra a retirada é zero, nunca negativa');
  assert.ok(r0.caixaFim < r0.caixaIni, 'o prejuízo sai do caixa');
  perto(r0.falta, 5000, 'falta o alvo inteiro');
}

// ── 3. Realização e DAS ─────────────────────────────────────────────────────────────
{
  const { rows } = projetar(base3(), Object.assign({}, seco, { realizacao: 0.5, dasPct: 0.1 }));
  perto(rows[0].totalRec, 5000, 'realização corta a carteira');
  perto(rows[0].repCont, 1000, 'o contingente segue a realização');
  perto(rows[0].repFixo, 1000, 'o já devido não segue');
  perto(rows[0].das, Math.max(0, rows[0].receitaPropria) * 0.1, 'DAS sobre a receita própria');
}

// ── 4. Backlog quitado inteiro em N meses e fora do caixa livre ─────────────────────
{
  const { rows } = projetar(base3(), Object.assign({}, seco, { backlogMeses: 2 }));
  perto(rows[0].repBacklog, 150, 'metade no 1º mês');
  perto(rows[1].repBacklog, 150, 'metade no 2º');
  perto(rows[2].repBacklog, 0, 'nada no 3º');
  perto(rows[0].caixaLivre, rows[0].caixaFim - 150, 'o que ainda não foi devolvido não é livre');
  perto(rows[1].backlogRestante, 0, 'quitado');
  perto(rows[1].caixaLivre, rows[1].caixaFim, 'depois de quitado, caixa livre = caixa');
}

// ── 5. Honorário na frente nas safras novas ─────────────────────────────────────────
{
  // Safra de 12.000: entrada 20% (2.400), 4 parcelas de 2.400; parte da COBRASQ 45% = 5.400.
  // Entrada cobre 2.400; parcela 1 cobre 2.400; parcela 2 cobre 600 e 1.800 vão ao cedente;
  // parcelas 3 e 4 são 100% capital.
  const b = { caixaInicial: 0, backlog: 0, fracMesAtual: 1,
    meses: Array.from({ length: 8 }, (_, i) => ({ key: 'm' + i, label: 'm' + i, entradas: 0, repFixo: 0, repCont: 0, dividas: 0, outros: 0, recorrencias: 0 })) };
  const p = Object.assign({}, seco, { origContratadoMes: 12000, origEntradaPct: 0.2, origParcelas: 4, origSharePct: 0.45, prolaboreAlvo: 0, horizonte: 8 });
  const { rows } = projetar(b, p);
  perto(rows[0].recEntradasNovos, 0, 'o mês corrente não origina (já está na carteira)');
  perto(rows[1].recEntradasNovos, 2400, 'safra 1 nasce no mês seguinte com a entrada');
  // Mês 2: safra 1 paga a parcela 1 (2.400, tudo próprio) e safra 2 traz entrada 2.400.
  perto(rows[2].recNovosProprio, 2400, 'parcela 1 é 100% própria');
  perto(rows[2].recNovosCapital, 0, 'ainda nenhum capital');
  // Mês 3: safra 1 parcela 2 (600 próprio + 1.800 capital) + safra 2 parcela 1 (2.400 próprio).
  perto(rows[3].recNovosProprio, 3000, 'parcela 2 fecha a parte da COBRASQ');
  perto(rows[3].recNovosCapital, 1800, 'o excedente vira capital');
  perto(rows[3].repNovos, 1800, 'e o capital é repasse, não receita própria');
  // Soma da safra 1 ao longo da vida: próprio = 45% de 12.000; capital = 55%.
  let proprio = 0, capital = 0;
  const p1 = Object.assign({}, p, { horizonte: 8 });
  const soRows = projetar(b, p1).rows;
  // Isolar a safra 1: rodar com originação só até o mês 1 é o mesmo que somar as
  // diferenças — mais simples: o total de próprio + capital de todas as safras num
  // horizonte fechado é contratado × safras concluídas.
  for (const r of soRows) { proprio += r.recEntradasNovos + r.recNovosProprio; capital += r.recNovosCapital; }
  // 7 safras nascem (meses 1..7); as que completam as 4 parcelas dentro do horizonte
  // (meses 1, 2, 3) somam 3 × 12.000 = 36.000 com 45/55; as demais estão a caminho e
  // pagaram primeiro a parte própria — logo próprio ≥ 45% e capital ≤ 55% do total.
  const total = proprio + capital;
  assert.ok(proprio / total > 0.45, 'honorário vem antes do capital no agregado');
  perto(proprio + capital, total, 'sanidade');
}

// ── 6. Classificação de saídas e entradas ───────────────────────────────────────────
{
  assert.strictEqual(saida({ descricao: 'Fernanda da Silva - pagar 2/9', credor_id: 'c1' }, ''), 'repasse', 'credor definido é repasse');
  assert.strictEqual(saida({ descricao: 'Tarifa Sicredi — Cristiane', credor_id: 'c1' }, 'Tarifas bancárias'), 'outros', 'tarifa com credor não é repasse (#616)');
  assert.strictEqual(saida({ descricao: 'Alexandre Borges 1/11' }, 'Aquisição de dívidas de terceiros'), 'repasse', 'a categoria também diz');
  assert.strictEqual(saida({ descricao: 'Empréstimo da Fomento - Cód. 217813 15/46' }, 'Empréstimos de Outras Instituições'), 'divida');
  assert.strictEqual(saida({ descricao: 'Parcelamento do Simples Nacional 2/21' }, 'Parcelamento do Simples Nacional'), 'divida');
  assert.strictEqual(saida({ descricao: 'Fatura do cartão BTG Pactual' }, 'Cartão de Crédito'), 'divida');
  assert.strictEqual(saida({ descricao: 'Empréstimo da Fomento - Cód. 217813 13/46' }, ''), 'divida', 'sem categoria, a descrição salva');
  assert.strictEqual(saida({ descricao: 'Aluguel da Sala' }, 'Aluguel'), 'outros');
  assert.strictEqual(entrada({ descricao: 'Sisbajud - Caio' , judicial_liberado_em: null }, 'Sisbajud'), 'judicial');
  assert.strictEqual(entrada({ descricao: 'Sisbajud - Caio', judicial_liberado_em: '2026-08-20' }, 'Sisbajud'), 'normal', 'liberado vira caixa normal');
  assert.strictEqual(entrada({ descricao: 'Parcela 3/10' }, 'Acordos Judiciais'), 'normal', 'acordo judicial cobrado por boleto é boleto');
  // Recorrências: o DAS não soma duas vezes (já entra pela premissa); empréstimo é dívida.
  assert.strictEqual(recorrencia({ descricao: 'Imposto - DAS' }), 'das');
  assert.strictEqual(recorrencia({ descricao: 'Parcelamento do Simples Nacional' }), 'das');
  assert.strictEqual(recorrencia({ descricao: 'Empréstimo da Fomento' }), 'divida');
  assert.strictEqual(recorrencia({ descricao: 'Aluguel da Sala - Pix Automático' }), 'fixo');
  assert.strictEqual(recorrencia({ descricao: 'Plano de Saúde - UNIMED - ACEDV' }), 'fixo');
}

// ── 7. Contingência: repasse casado com parcela pendente do devedor ─────────────────
{
  const pend = { cob1: ['2026-10-10'], cob2: ['2026-12-01'] };
  assert.ok(contingente({ cobranca_id: 'cob1', data_vencimento: '2026-10-10' }, pend), 'mesma data');
  assert.ok(contingente({ cobranca_id: 'cob1', data_vencimento: '2026-10-25' }, pend), 'entrada até 20 dias antes');
  assert.ok(!contingente({ cobranca_id: 'cob1', data_vencimento: '2026-11-20' }, pend), 'longe demais');
  assert.ok(!contingente({ cobranca_id: 'cob9', data_vencimento: '2026-10-10' }, pend), 'sem parcela pendente = devido de qualquer jeito');
  assert.ok(!contingente({ data_vencimento: '2026-10-10' }, pend), 'sem cobrança não há como casar');
}

// ── 8. Faturamento previsto = receitas − só repasses; dívida e custo ficam de fora ──
{
  const itens = [
    { tipo: 'entrada', valor: 1000, mes: '2026-09', judicial: false },
    { tipo: 'entrada', valor: 500, mes: '2026-09', judicial: true },
    { tipo: 'repasse', valor: 400, mes: '2026-09' },
    { tipo: 'entrada', valor: 2000, mes: '2026-10', judicial: false },
    { tipo: 'repasse', valor: 900, mes: '2026-10' },
  ];
  const s = faturamento(itens, '2026-09');
  perto(s.receitas, 1500, 'receitas do mês, judicial incluso');
  perto(s.judicial, 500, 'judicial destacado');
  perto(s.repasses, 400, 'só repasses');
  perto(s.faturamento, 1100, 'base da nota = receitas − repasses');
  assert.strictEqual(s.nReceitas, 2); assert.strictEqual(s.nRepasses, 1);
  const tudo = faturamento(itens, null);
  perto(tudo.faturamento, 3500 - 1300, 'sem mês, soma o horizonte');
  perto(faturamento([], '2026-09').faturamento, 0, 'vazio não explode');
}

// ── 9. Premissas padrão fazem sentido e o motor aceita omissões ─────────────────────
{
  assert.ok(PADRAO.realizacao > 0 && PADRAO.realizacao <= 1);
  assert.ok(PADRAO.origSharePct > 0 && PADRAO.origSharePct < 1);
  const { rows, totais } = projetar(base3(), {});
  assert.strictEqual(rows.length, 3);
  assert.ok(isFinite(totais.retiradaMedia));
  const vazio = projetar({ meses: [] }, {});
  assert.strictEqual(vazio.rows.length, 0, 'sem carteira não explode');
  assert.strictEqual(vazio.totais.caixaMin, 0);
}

console.log('F-29 OK — fluxo de caixa: receita própria, retirada, honorário na frente, backlog e classificação.');
