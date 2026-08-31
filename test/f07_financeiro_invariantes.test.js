/*
 * Teste F-07 (Financeiro — invariantes do derivador único).
 *
 * O handoff "Financeiro COBRASQ" é explícito: quase todos os defeitos do protótipo
 * vieram de número calculado em dois lugares. A Fase 1 exige UMA função de agregação de
 * onde saem todos os números da tela, e lista dez invariantes que ela precisa garantir.
 * Este teste é esse contrato.
 *
 * Roda contra o CÓDIGO REAL do index.html, sem rede e sem navegador: as funções são
 * recortadas do arquivo por casamento de chaves e avaliadas num sandbox com um Supabase
 * de mentira. Se alguém reescrever um total à mão em qualquer card, o invariante quebra
 * aqui antes de quebrar na tela.
 *
 * Como rodar:
 *   node test/f07_financeiro_invariantes.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// ── Recorte por casamento de chaves ────────────────────────────────────────────────
// Pegar o texto até o próximo "\n}" não serve: quase toda função aqui tem template
// literal com `}` dentro. Contamos chaves ignorando strings, template literals,
// comentários e regex — é o que faz o recorte sobreviver a `${...}` aninhado.
// Recorte de uma linha só (const/arrow), quando não há chaves a casar.
function trechoAte(marca, fim) {
  const i = HTML.indexOf(marca);
  assert.ok(i >= 0, `não achei no index.html: ${marca}`);
  const j = HTML.indexOf(fim, i + marca.length);
  assert.ok(j > i, `não achei o fim de ${marca}`);
  return HTML.slice(i, j + fim.length);
}
function recorta(marca, abre) {
  abre = abre || '{';
  const fecha = abre === '[' ? ']' : '}';
  const ini = HTML.indexOf(marca);
  assert.ok(ini >= 0, `não achei no index.html: ${marca}`);
  let i = HTML.indexOf(abre, ini);
  let nivel = 0;
  const tpl = []; // pilha de template literals abertos
  for (; i < HTML.length; i++) {
    const c = HTML[i], prox = HTML[i + 1];
    if (c === '/' && prox === '/') { i = HTML.indexOf('\n', i); continue; }
    if (c === '/' && prox === '*') { i = HTML.indexOf('*/', i) + 1; continue; }
    if (c === '\\') { i++; continue; }
    if (c === '`') { if (tpl.length && tpl[tpl.length - 1] === 0) tpl.pop(); else tpl.push(0); continue; }
    if (tpl.length) {
      // Dentro de template: só `${` reabre código.
      if (c === '$' && prox === '{') { tpl.push(1); nivel++; i++; continue; }
      if (c === '}' && tpl[tpl.length - 1] === 1) { tpl.pop(); nivel--; continue; }
      if (tpl[tpl.length - 1] === 0) continue;
    }
    if (c === '"' || c === "'") { const q = c; i++; for (; i < HTML.length && HTML[i] !== q; i++) if (HTML[i] === '\\') i++; continue; }
    if (c === abre) nivel++;
    else if (c === fecha) { nivel--; if (nivel === 0) return HTML.slice(ini, i + 1) + (abre === '[' ? ';' : ''); }
    else if (abre === '[' && c === '{') { // objeto dentro do array: pula até fechar
      let n2 = 0;
      for (; i < HTML.length; i++) {
        const d = HTML[i];
        if (d === '\\') { i++; continue; }
        if (d === '"' || d === "'" || d === '`') { const q = d; i++; for (; i < HTML.length && HTML[i] !== q; i++) if (HTML[i] === '\\') i++; continue; }
        if (d === '{') n2++;
        else if (d === '}') { n2--; if (n2 === 0) break; }
      }
    }
  }
  throw new Error(`chaves não fecharam em: ${marca}`);
}

// ── Supabase de mentira ────────────────────────────────────────────────────────────
// Só o suficiente para o encadeamento que o código real usa: select/gte/lte/eq/in/not/
// is/order/range/limit/maybeSingle/single. Cada tabela devolve as linhas do fixture já
// filtradas pelos predicados aplicados — sem isso o teste não exercitaria os cortes.
function fakeSupabase(tabelas) {
  const aplica = (linhas, ops) => linhas.filter(l => ops.every(o => {
    const v = l[o.col];
    switch (o.tipo) {
      case 'eq': return String(v) === String(o.val);
      case 'gte': return v != null && String(v) >= String(o.val);
      case 'lte': return v != null && String(v) <= String(o.val);
      case 'lt': return v != null && String(v) < String(o.val);
      case 'in': return o.val.map(String).includes(String(v));
      case 'isNull': return v == null;
      case 'notNull': return v != null;
      default: return true;
    }
  }));
  const q = (tabela) => {
    const ops = [];
    const self = {
      select() { return self; },
      eq(col, val) { ops.push({ tipo: 'eq', col, val }); return self; },
      gte(col, val) { ops.push({ tipo: 'gte', col, val }); return self; },
      lte(col, val) { ops.push({ tipo: 'lte', col, val }); return self; },
      lt(col, val) { ops.push({ tipo: 'lt', col, val }); return self; },
      in(col, val) { ops.push({ tipo: 'in', col, val }); return self; },
      is(col) { ops.push({ tipo: 'isNull', col }); return self; },
      not(col, op, val) { if (op === 'is' && val === null) ops.push({ tipo: 'notNull', col }); return self; },
      or() { return self; },
      order() { return self; },
      limit() { return Promise.resolve({ data: aplica(tabelas[tabela] || [], ops), error: null }); },
      range(de, ate) {
        const todas = aplica(tabelas[tabela] || [], ops);
        return Promise.resolve({ data: todas.slice(de, ate + 1), error: null });
      },
      maybeSingle() { const r = aplica(tabelas[tabela] || [], ops); return Promise.resolve({ data: r[0] || null, error: null }); },
      single() { const r = aplica(tabelas[tabela] || [], ops); return Promise.resolve({ data: r[0] || null, error: null }); },
      then(res, rej) { return self.limit().then(res, rej); },
    };
    return self;
  };
  return { from: q, rpc: () => Promise.resolve({ data: [], error: null }) };
}

// ── Relógio fixo ──────────────────────────────────────────────────────────────────
// _finCaixaAgg lê o relógio (mês corrente, hoje, próximos 7 dias). Com a data real, o
// mesmo fixture passa hoje e falha dia 30 — "a entrar até o fim do mês" vira atraso.
// O sandbox recebe um Date congelado em 15/08/2026, e o fixture é desse mês.
const AGORA = new Date(2026, 7, 15, 12, 0, 0);
class DataFixa extends Date {
  constructor(...a) { if (a.length === 0) super(AGORA.getTime()); else super(...a); }
  static now() { return AGORA.getTime(); }
}

// ── Fixture ───────────────────────────────────────────────────────────────────────
const p2 = n => String(n).padStart(2, '0');
const Y = 2026, M = 8;
const dia = d => `${Y}-${p2(M)}-${p2(Math.min(d, 31))}`;
const HOJE = dia(15);
const ONTEM = dia(14);

const CAT_SISBAJUD = 'cat-sis', CAT_ACORDO = 'cat-aco', CAT_ALUGUEL = 'cat-alu';

const LANCAMENTOS = [
  // Recebidas de verdade: 2.000 + 500 = 2.500 de receita realizada.
  { id: 1, descricao: 'Acordo Ana 1/3', valor: 2000, tipo_movimento: 1, status: 1, data_pagamento: dia(3), data_vencimento: dia(3), data_competencia: dia(3), conciliado: true, numero_parcela: 1, total_parcelas: 3, credor_id: 'cli-1', judicial_liberado_em: null, conta_id: 'c1' },
  { id: 2, descricao: 'Acordo Bruno 1/2', valor: 500, tipo_movimento: 1, status: 1, data_pagamento: dia(5), data_vencimento: dia(5), data_competencia: dia(5), conciliado: false, numero_parcela: 1, total_parcelas: 2, credor_id: null, judicial_liberado_em: null, conta_id: 'c1' },
  // Despesa paga: 300.
  { id: 3, descricao: 'Aluguel', valor: -300, tipo_movimento: 0, status: 1, data_pagamento: dia(4), data_vencimento: dia(4), data_competencia: dia(4), conciliado: false, numero_parcela: null, total_parcelas: null, credor_id: null, judicial_liberado_em: null, conta_id: 'c1' },
  // Entrada ATRASADA — inadimplência, nunca receita.
  { id: 4, descricao: 'Acordo Ana 2/3', valor: 900, tipo_movimento: 1, status: 0, data_pagamento: null, data_vencimento: ONTEM, data_competencia: ONTEM, conciliado: false, numero_parcela: 2, total_parcelas: 3, credor_id: 'cli-1', judicial_liberado_em: null, conta_id: 'c2' },
  // Entrada prevista para o fim do mês.
  { id: 5, descricao: 'Acordo Bruno 2/2', valor: 400, tipo_movimento: 1, status: 0, data_pagamento: null, data_vencimento: dia(28), data_competencia: dia(28), conciliado: false, numero_parcela: 2, total_parcelas: 2, credor_id: null, judicial_liberado_em: null, conta_id: 'c1' },
  // JUDICIAL pendente e VENCIDO: é a armadilha do handoff — não pode contar como atraso
  // nem como previsão de entrada, e não pode aparecer em Movimentações.
  { id: 6, descricao: 'Sisbajud Carlos', valor: 5000, tipo_movimento: 1, status: 0, data_pagamento: null, data_vencimento: ONTEM, data_competencia: ONTEM, conciliado: false, numero_parcela: null, total_parcelas: null, credor_id: null, judicial_liberado_em: null, conta_id: 'c1' },
  // Judicial JÁ LIBERADO: volta a ser entrada normal e conta como receita.
  { id: 7, descricao: 'Penhora Denise', valor: 700, tipo_movimento: 1, status: 1, data_pagamento: dia(6), data_vencimento: dia(6), data_competencia: dia(6), conciliado: true, numero_parcela: null, total_parcelas: null, credor_id: null, judicial_liberado_em: dia(6), conta_id: 'c1' },
  // Espelho de despesa do repasse (lancamento_despesa_id da operação): dinheiro de
  // terceiro voltando ao dono, não custo da COBRASQ.
  { id: 8, descricao: 'Repasse ao credor — Ana', valor: -1600, tipo_movimento: 0, status: 1, data_pagamento: dia(7), data_vencimento: dia(7), data_competencia: dia(7), conciliado: false, numero_parcela: null, total_parcelas: null, credor_id: 'cli-1', judicial_liberado_em: null, conta_id: 'c2' },
];

const TABELAS = {
  fin_lancamento: LANCAMENTOS,
  fin_lancamento_categoria: [
    { lancamento_id: 1, valor: 2000, categoria_id: CAT_ACORDO, fin_categoria: { descricao: 'Acordos Extrajudiciais' } },
    { lancamento_id: 2, valor: 500, categoria_id: CAT_ACORDO, fin_categoria: { descricao: 'Acordos Extrajudiciais' } },
    // Rateio DESPROPORCIONAL de propósito: 200 + 200 para um lançamento de 300. O rateio
    // do código é proporcional (p.valor / somaPartes), então cada categoria fica com 150.
    // Sem isto, trocar o rateio proporcional por `sinal * p.valor` passava no teste.
    { lancamento_id: 3, valor: 200, categoria_id: CAT_ALUGUEL, fin_categoria: { descricao: 'Aluguel' } },
    { lancamento_id: 3, valor: 200, categoria_id: CAT_ACORDO,  fin_categoria: { descricao: 'Condomínio' } },
    { lancamento_id: 6, valor: 5000, categoria_id: CAT_SISBAJUD, fin_categoria: { descricao: 'Sisbajud/Penhoras' } },
    { lancamento_id: 7, valor: 700, categoria_id: CAT_SISBAJUD, fin_categoria: { descricao: 'Penhora de remuneração' } },
  ],
  fin_operacao: [
    { id: 'op-1', credor_id: 'cli-1', valor_recebido: 2000, valor_capital: 1600, valor_honorario: 400, repasse_status: 'pendente', recebido_em: dia(3), criada_em: dia(3), lancamento_despesa_id: 8, lancamento_receita_id: 1 },
  ],
  clientes: [{ id: 'cli-1', nome: 'Arte Estofados', nome_fantasia: null }],
  acordos: [
    { id: 'ac-1', metadata: {}, data_assinatura: `${dia(2)}T10:00:00-03:00` },                                  // do mês, sem conferir
    { id: 'ac-2', metadata: { posAssinatura: { conferidoEm: dia(3) } }, data_assinatura: `${dia(3)}T09:00:00-03:00` }, // do mês, conferido
    // Borda do fuso: 31/08 às 22h em Brasília é 01/09 01h em UTC. Comparando a janela
    // como texto, este acordo caía em setembro e sumia do card "Acordos de agosto".
    { id: 'ac-3', metadata: {}, data_assinatura: `${dia(31)}T22:00:00-03:00` },
    { id: 'ac-4', metadata: {}, data_assinatura: '2026-09-02T10:00:00-03:00' },                                 // fora: mês seguinte
  ],
};

// ── Sandbox ───────────────────────────────────────────────────────────────────────
const fonte = [
  recorta('function _finCaixaHoje(){'),
  recorta('function _finDiasUteisRestantes(){'),
  recorta('function _finSaldoIdadeDias(conta){'),
  'const FIN_SALDO_STALE_DIAS = 7;',
  // `_finCascataMetricas` entra de VERDADE no recorte. Antes ela era substituída por uma
  // constante no sandbox, e o invariante 1 ("caixa livre = saldo geral − terceiros")
  // media o fixture, não o código: trocando a subtração por soma no index.html, o teste
  // continuava verde. Agora ele quebra.
  'let _finCascataCache = { at:0, m:null };',
  recorta('async function _finCascataMetricas(force){'),
  'let _finCaixaAggCache = { at:0, v:null };',
  recorta('async function _finCaixaAgg(force){'),
  recorta('function _finLancSit(l){'),
  // `_finEhTarifa` entrou em 31/08 (F-18): tarifa do Asaas não é repasse ao cedente, e a
  // exclusão passou a morar num helper só, usado pelas três leituras.
  trechoAte('const _finEhTarifa', '\n'),
  trechoAte('const _finLancQuitado', '\n'),
  recorta('function _finLancEhRepasse(l, ctx){'),
  recorta('function _finLancEhDivergencia(l, ctx){'),
  recorta('function _finLancCedente(l, ctx){'),
  recorta('const FIN_MOV_VISOES = [', '['),
  recorta('function _finLancCascataFiltrados(visaoId){'),
  recorta('function _finMovVencidos(){'),
  recorta('function _finMovContadorVisao(visaoId){'),
  recorta('function _finLancEhJudicialPendente(r, judSet){'),
  recorta('function _finMovZerarFiltros(s){'),
  // `const` num script de vm não vira propriedade do contexto — sem isto o teste não
  // enxerga as visões e o invariante 10 nem chega a rodar.
  'globalThis.FIN_MOV_VISOES = FIN_MOV_VISOES;',
].join('\n\n');

// Contas do fixture: saldo geral 10.000 = 7.000 + 3.000 (a terceira fica fora do geral).
const CONTAS = [
  { id: 'c1', descricao: 'Asaas',   bank_balance: 7000, bank_balance_at: null, saldo_inicial: 0, incluir_no_saldo_geral: true },
  { id: 'c2', descricao: 'Sicredi', bank_balance: 3000, bank_balance_at: null, saldo_inicial: 0, incluir_no_saldo_geral: true },
  { id: 'c3', descricao: 'CENSEC',  bank_balance: 999,  bank_balance_at: null, saldo_inicial: 0, incluir_no_saldo_geral: false },
];

const ctxVm = {
  console,
  Date: DataFixa, Math, JSON, Object, Set, Map, Promise, Number, String, Array, isFinite, parseFloat, parseInt,
  getSupabase: () => fakeSupabase(TABELAS),
  hoje: () => HOJE,
  // Só o que é I/O é falso. A aritmética do caixa livre roda de verdade.
  finApi: { loadDimensoes: async () => ({ contas: CONTAS, categorias: [], contatos: [] }) },
  _finRepasseAgg: async () => ({ aRepassar: 1600, filaCount: 1, pendCount: 1, revisarCount: 0 }),
  DB: { config: { metaMensal: 40000 } },
  // O recorte de Movimentações lê o estado e o contexto pelo `window` — o mesmo caminho
  // que a tela usa, para o teste exercitar o filtro de verdade e não uma cópia dele.
  parseValorBR: (v) => { if (!v && v !== 0) return 0; const t = String(v).replace(/[^0-9,.-]/g, ''); return t.includes(',') ? (parseFloat(t.replace(/\./g, '').replace(',', '.')) || 0) : (parseFloat(t) || 0); },
  _finLancCascataState: { visao: 'tudo', busca: '', sel: new Set(), ord: { col: 'data', dir: 'asc' }, fTipo: '', fStatus: '', fContas: [], fCategoria: '', fCedente: '', fMin: '', fMax: '', limite: 60 },
};
ctxVm.window = ctxVm;
vm.createContext(ctxVm);
vm.runInContext(fonte, ctxVm);

// ── Os invariantes ────────────────────────────────────────────────────────────────
let falhas = 0;
function ok(nome, cond, detalhe) {
  if (cond) { console.log(`  ok  ${nome}`); return; }
  falhas++;
  console.log(`  FALHOU  ${nome}${detalhe ? ' — ' + detalhe : ''}`);
}
const perto = (a, b) => Math.abs(a - b) < 0.005;

(async () => {
  console.log('F-07 · invariantes do Financeiro\n');
  const A = await ctxVm._finCaixaAgg(true);

  // 1. caixa livre = saldo geral − dinheiro de terceiros.
  ok('1 · caixa livre = saldo geral − terceiros',
    perto(A.caixaLivre, A.saldoGeral - A.terceiros),
    `${A.caixaLivre} ≠ ${A.saldoGeral} − ${A.terceiros}`);

  // 2. resultado realizado = recebido − pago, SÓ liquidado. A entrada atrasada de 900 e
  //    a previsão de 400 não podem estar na receita; o judicial pendente de 5.000 também
  //    não; o judicial já liberado de 700 tem de estar.
  ok('2 · resultado = recebido − pago (só liquidado)',
    perto(A.resultado, A.receita - A.despesa), `${A.resultado} ≠ ${A.receita} − ${A.despesa}`);
  ok('2a · receita = 2.000 + 500 + 700 (judicial liberado entra, atrasado e previsto não)',
    perto(A.receita, 3200), `receita = ${A.receita}`);
  ok('2b · despesa = 300 (o espelho do repasse fica fora: é dinheiro de terceiro)',
    perto(A.despesa, 300), `despesa = ${A.despesa}`);

  // 3. O caixa livre é DERIVADO, não copiado: mexer no saldo de uma conta tem de mover o
  //    caixa livre na mesma medida. Com _finCascataMetricas real no recorte, esta
  //    asserção passa a exercitar a subtração de verdade.
  ok('3 · caixa livre acompanha o saldo das contas (derivação real)',
    perto(A.saldoGeral, 10000) && perto(A.caixaLivre, 10000 - 1600),
    `saldoGeral=${A.saldoGeral} caixaLivre=${A.caixaLivre}`);
  ok('3a · conta fora do saldo geral não entra', A.contasCount === 2, `contasCount=${A.contasCount}`);

  // 4. Rodapé do DRE = KPI de resultado: a soma das categorias tem de fechar com ele.
  const somaCats = A.cats.reduce((s, c) => s + c.valor, 0);
  ok('4 · soma do resultado por categoria = resultado realizado',
    perto(somaCats, A.resultado), `${somaCats} ≠ ${A.resultado}`);
  // 4a. O rateio é PROPORCIONAL: o lançamento 3 vale 300 e está dividido em duas partes
  //     de 200. Cada categoria fica com 150, não com 200. Esta é a asserção que pega
  //     alguém trocando o rateio proporcional pelo valor bruto de cada parte.
  const alug = A.cats.find(c => c.nome === 'Aluguel');
  const cond = A.cats.find(c => c.nome === 'Condomínio');
  ok('4a · rateio proporcional quando as partes não somam o valor da linha',
    !!alug && !!cond && perto(alug.valor, -150) && perto(cond.valor, -150),
    JSON.stringify([alug, cond]));

  // 5. cedente recebe + honorário = recebido, por linha e no total da fila.
  const fila = A.fila || [];
  ok('5 · cedente recebe + honorário = recebido, em cada linha da fila',
    fila.every(g => perto(g.capital + g.honorario, g.recebido)),
    JSON.stringify(fila.map(g => [g.capital, g.honorario, g.recebido])));
  ok('5a · "a repassar ao cedente" = soma da fila',
    perto(A.repasseT, fila.reduce((s, g) => s + g.capital, 0)));
  ok('5b · dinheiro de terceiros do card escuro = a fila de repasses',
    perto(A.terceiros, 1600), `terceiros = ${A.terceiros}`);

  // 6. Toda saída de repasse nasce de uma parcela recebida; a razão repassado/recebido é
  //    1 − taxa de honorário (aqui, 20%).
  ok('6 · repassado/recebido = 1 − honorário',
    fila.every(g => perto(g.capital / g.recebido, 0.8)));

  // 7. Despesa recorrente aparece uma VEZ no mês (uma linha por rubrica, não repetida).
  const aluguel = A.cats.filter(c => c.nome === 'Aluguel');
  ok('7 · despesa recorrente aparece uma vez', aluguel.length === 1 && perto(aluguel[0].valor, -150),
    JSON.stringify(aluguel));

  // 8. DIVERGÊNCIA só existe em parcela recebida E com cedente.
  const ctxMov = { opsByLanc: {}, cedMap: { 'cli-1': 'Arte Estofados' }, credorPorLanc: {}, catPorLanc: {} };
  ok('8 · sem cedente não há divergência',
    ctxVm._finLancEhDivergencia({ id: 2, cedente_id: null, capital: null }, ctxMov) === false);
  ok('8a · com cedente e sem divisão calculada, há divergência',
    ctxVm._finLancEhDivergencia({ id: 1, cedente_id: 'cli-1', capital: null }, ctxMov) === true);

  // 9. Judicial pendente fora do atraso e fora da previsão de entrada.
  ok('9 · judicial pendente não conta como atraso (só a entrada de 900)',
    A.atrasoN === 1 && perto(A.atrasoT, 900), `atrasoN=${A.atrasoN} atrasoT=${A.atrasoT}`);
  ok('9a · judicial pendente não entra na previsão de entrada (só os 400)',
    A.aEntrarN === 1 && perto(A.aEntrarT, 400), `aEntrarN=${A.aEntrarN} aEntrarT=${A.aEntrarT}`);
  ok('9b · inadimplência = entradas atrasadas, sem judicial',
    perto(A.atrasoInT, 900), `atrasoInT = ${A.atrasoInT}`);

  // 10. Contador do chip = número de linhas que o filtro devolve. As duas coisas saem do
  //     MESMO predicado (FIN_MOV_VISOES[].ok) — este teste trava justamente isso.
  const linhas = LANCAMENTOS.filter(l => l.id !== 6); // judicial pendente já saiu da base
  const ctx2 = {
    rows: linhas,
    opsByLanc: { 1: TABELAS.fin_operacao[0], 8: TABELAS.fin_operacao[0] },
    cedMap: { 'cli-1': 'Arte Estofados' },
    credorPorLanc: {},
    catPorLanc: {},
  };
  ctxVm.window._finLancCascataCtx = ctx2;
  for (const v of ctxVm.FIN_MOV_VISOES) {
    // Contador do chip: a MESMA função que o render chama (não uma cópia da expressão).
    const contados = ctxVm._finMovContadorVisao(v.id);
    // Lista: o caminho real de filtragem da tela, com o painel de filtros limpo.
    ctxVm._finMovZerarFiltros(ctxVm._finLancCascataState);
    ctxVm._finLancCascataState.visao = v.id;
    const filtrados = ctxVm._finLancCascataFiltrados().length;
    ok(`10 · chip "${v.label}": contador = linhas da lista (${contados})`, contados === filtrados,
      `chip ${contados} × lista ${filtrados}`);
  }
  // 10e. O TESTE QUE FALTAVA. O contador do chip e a lista têm de bater também com o
  //      painel de filtros ativo. Antes o chip contava só o predicado da visão: com um
  //      filtro de conta ligado ele dizia 3 e a lista devolvia 1, e nenhuma asserção
  //      pegava isso porque o teste zerava os filtros antes de comparar.
  ctxVm._finMovZerarFiltros(ctxVm._finLancCascataState);
  ctxVm._finLancCascataState.visao = 'tudo';
  ctxVm._finLancCascataState.fContas = ['c1'];
  const soC1 = ctx2.rows.filter(l => String(l.conta_id) === 'c1').length;
  ok('10e-pré · o fixture tem conta variada (senão o filtro não discrimina)',
    soC1 > 0 && soC1 < ctx2.rows.length, `${soC1} de ${ctx2.rows.length} em c1`);
  for (const v of ctxVm.FIN_MOV_VISOES) {
    ctxVm._finLancCascataState.visao = v.id;
    const chip = ctxVm._finMovContadorVisao(v.id);              // o número que o chip imprime
    const lista = ctxVm._finLancCascataFiltrados().length;      // o que a lista devolve ao clicar
    ok(`10e · com filtro de conta, chip "${v.label}" = lista (${chip})`, chip === lista, `chip ${chip} × lista ${lista}`);
  }
  ctxVm._finLancCascataState.visao = 'tudo';
  ok('10f · o filtro de conta realmente recorta', ctxVm._finLancCascataFiltrados().length === soC1);
  ctxVm._finMovZerarFiltros(ctxVm._finLancCascataState);

  // Rodapé: "Efetivar N vencidos" tem de sair do filtro inteiro e só de linhas atrasadas.
  ctxVm._finMovZerarFiltros(ctxVm._finLancCascataState);
  ctxVm._finLancCascataState.visao = 'tudo';
  const venc = ctxVm._finMovVencidos();
  ok('10c · vencidos do rodapé saem do filtro e são todos atrasados',
    venc.length === 1 && venc.every(l => ctxVm._finLancSit(l).t === 'ATRASADO'),
    `${venc.length} vencido(s)`);
  // O painel de filtros recorta a MESMA base: filtrar por "Saídas" tem de bater com a
  // contagem por tipo_movimento, e não com uma lista paralela.
  ctxVm._finLancCascataState.fTipo = 'out';
  ok('10d · painel de filtros (Tipo=Saídas) recorta a mesma base',
    ctxVm._finLancCascataFiltrados().length === ctx2.rows.filter(l => l.tipo_movimento === 0).length);
  ctxVm._finMovZerarFiltros(ctxVm._finLancCascataState);
  ok('10a · a visão "Atrasados" não devolve o judicial pendente',
    ctxVm.FIN_MOV_VISOES.find(v => v.id === 'atrasados').ok(linhas.find(l => l.id === 4), ctx2) === true
    && !linhas.some(l => l.id === 6));
  // A linha 8 do fixture é um repasse PAGO, e desde 31/08 repasse já quitado nunca é
  // "a repassar" (F-23) — o estado dela (paga + operação pendente) não existe em produção,
  // conferido: zero casos. O invariante é sobre a ORIGEM, então exercita o predicado com um
  // repasse em aberto, sem mexer no fixture (que alimenta os agregados de 2b e 10c).
  ok('10b · a visão "A repassar" acha o repasse pela operação',
    ctxVm.FIN_MOV_VISOES.find(v => v.id === 'repassar').ok(
      { id: 8, tipo_movimento: 0, status: 0, data_pagamento: null, conciliado: false,
        descricao: 'Repasse ao credor — Ana', credor_id: 'cli-1' }, ctx2) === true);
  ok('10b2 · e não acha o repasse que já saiu',
    ctxVm.FIN_MOV_VISOES.find(v => v.id === 'repassar').ok(linhas.find(l => l.id === 8), ctx2) === false);

  // 11. Acordos assinados no mês — inclusive o das 22h do último dia, que a comparação
  //     de texto em UTC jogava para o mês seguinte.
  ok('11 · acordos assinados no mês (com a borda do fuso)',
    A.assinadosN === 3, `assinadosN=${A.assinadosN} (esperado 3: dia 2, dia 3 e o das 22h do dia 31)`);
  ok('11a · quantos ainda não passaram pelo passo 1',
    A.semConferirN === 2, `semConferirN=${A.semConferirN}`);

  // 12. O corte do judicial é um predicado próprio e testável: sem `judicial_liberado_em`
  //     a linha é pendente e não pode chegar a Movimentações; com a data, ela volta.
  const jud = new Set(['6']);
  ok('12 · judicial sem liberação é pendente',
    ctxVm._finLancEhJudicialPendente({ id: 6, judicial_liberado_em: null }, jud) === true);
  ok('12a · judicial já liberado deixa de ser pendente',
    ctxVm._finLancEhJudicialPendente({ id: 6, judicial_liberado_em: dia(6) }, jud) === false);
  ok('12b · linha que não é judicial nunca é cortada',
    ctxVm._finLancEhJudicialPendente({ id: 1, judicial_liberado_em: null }, jud) === false);

  // 13. GUARDA DE FONTE. As duas regras acima só valem se quem desenha e quem carrega
  //     REALMENTE as chamarem. Um render que volte a contar por conta própria, ou um
  //     carregador que pare de aplicar o corte, não é observável num sandbox sem DOM —
  //     então é travado aqui, no texto do arquivo.
  const fonteHTML = HTML;
  ok('13 · o chip usa o contador compartilhado',
    /const n = _finMovContadorVisao\(v\.id\);/.test(fonteHTML)
    && !/const n = ctx\.rows\.filter\(l => v\.ok\(l, ctx\)\)\.length;/.test(fonteHTML),
    'o render voltou a contar o chip por conta própria');
  ok('13a · o carregador aplica o corte do judicial',
    /const ehJudPendente = r => _finLancEhJudicialPendente\(r, judSet\);/.test(fonteHTML)
    && /rows\.filter\(r => !ehJudPendente\(r\)\)/.test(fonteHTML),
    'o corte do judicial saiu de _finLancCascataCarregar');
  ok('13b · a janela de acordos usa offset explícito, não texto UTC',
    !/\.lte\('data_assinatura', mesFim \+ 'T23:59:59'\)/.test(fonteHTML),
    'a janela de data_assinatura voltou a comparar timestamptz como texto');

  // Extra: a situação da linha é derivada num lugar só — a lista, a ordenação e o polegar
  // leem daqui, então errar aqui erra os três de uma vez.
  ok('extra · situação: pago, atrasado e a receber',
    ctxVm._finLancSit(linhas.find(l => l.id === 1)).t === 'CONCILIADO'
    && ctxVm._finLancSit(linhas.find(l => l.id === 4)).t === 'ATRASADO'
    && ctxVm._finLancSit(linhas.find(l => l.id === 5)).t === 'A RECEBER');

  console.log('');
  if (falhas) { console.error(`${falhas} invariante(s) quebrado(s).`); process.exit(1); }
  console.log('F-07 · todos os invariantes do handoff passaram.');
})().catch(e => { console.error(e); process.exit(1); });
