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
  { id: 4, descricao: 'Acordo Ana 2/3', valor: 900, tipo_movimento: 1, status: 0, data_pagamento: null, data_vencimento: ONTEM, data_competencia: ONTEM, conciliado: false, numero_parcela: 2, total_parcelas: 3, credor_id: 'cli-1', judicial_liberado_em: null, conta_id: 'c1' },
  // Entrada prevista para o fim do mês.
  { id: 5, descricao: 'Acordo Bruno 2/2', valor: 400, tipo_movimento: 1, status: 0, data_pagamento: null, data_vencimento: dia(28), data_competencia: dia(28), conciliado: false, numero_parcela: 2, total_parcelas: 2, credor_id: null, judicial_liberado_em: null, conta_id: 'c1' },
  // JUDICIAL pendente e VENCIDO: é a armadilha do handoff — não pode contar como atraso
  // nem como previsão de entrada, e não pode aparecer em Movimentações.
  { id: 6, descricao: 'Sisbajud Carlos', valor: 5000, tipo_movimento: 1, status: 0, data_pagamento: null, data_vencimento: ONTEM, data_competencia: ONTEM, conciliado: false, numero_parcela: null, total_parcelas: null, credor_id: null, judicial_liberado_em: null, conta_id: 'c1' },
  // Judicial JÁ LIBERADO: volta a ser entrada normal e conta como receita.
  { id: 7, descricao: 'Penhora Denise', valor: 700, tipo_movimento: 1, status: 1, data_pagamento: dia(6), data_vencimento: dia(6), data_competencia: dia(6), conciliado: true, numero_parcela: null, total_parcelas: null, credor_id: null, judicial_liberado_em: dia(6), conta_id: 'c1' },
  // Espelho de despesa do repasse (lancamento_despesa_id da operação): dinheiro de
  // terceiro voltando ao dono, não custo da COBRASQ.
  { id: 8, descricao: 'Repasse ao credor — Ana', valor: -1600, tipo_movimento: 0, status: 1, data_pagamento: dia(7), data_vencimento: dia(7), data_competencia: dia(7), conciliado: false, numero_parcela: null, total_parcelas: null, credor_id: 'cli-1', judicial_liberado_em: null, conta_id: 'c1' },
];

const TABELAS = {
  fin_lancamento: LANCAMENTOS,
  fin_lancamento_categoria: [
    { lancamento_id: 1, valor: 2000, categoria_id: CAT_ACORDO, fin_categoria: { descricao: 'Acordos Extrajudiciais' } },
    { lancamento_id: 2, valor: 500, categoria_id: CAT_ACORDO, fin_categoria: { descricao: 'Acordos Extrajudiciais' } },
    { lancamento_id: 3, valor: 300, categoria_id: CAT_ALUGUEL, fin_categoria: { descricao: 'Aluguel' } },
    { lancamento_id: 6, valor: 5000, categoria_id: CAT_SISBAJUD, fin_categoria: { descricao: 'Sisbajud/Penhoras' } },
    { lancamento_id: 7, valor: 700, categoria_id: CAT_SISBAJUD, fin_categoria: { descricao: 'Penhora de remuneração' } },
  ],
  fin_operacao: [
    { id: 'op-1', credor_id: 'cli-1', valor_recebido: 2000, valor_capital: 1600, valor_honorario: 400, repasse_status: 'pendente', recebido_em: dia(3), criada_em: dia(3), lancamento_despesa_id: 8, lancamento_receita_id: 1 },
  ],
  clientes: [{ id: 'cli-1', nome: 'Arte Estofados', nome_fantasia: null }],
  acordos: [{ id: 'ac-1', metadata: {}, data_assinatura: dia(2) }],
};

// ── Sandbox ───────────────────────────────────────────────────────────────────────
const fonte = [
  recorta('function _finCaixaHoje(){'),
  recorta('function _finDiasUteisRestantes(){'),
  'let _finCaixaAggCache = { at:0, v:null };',
  recorta('async function _finCaixaAgg(force){'),
  recorta('function _finLancSit(l){'),
  recorta('function _finLancEhRepasse(l, ctx){'),
  recorta('function _finLancEhDivergencia(l, ctx){'),
  recorta('function _finLancCedente(l, ctx){'),
  recorta('const FIN_MOV_VISOES = [', '['),
  recorta('function _finLancCascataFiltrados(){'),
  recorta('function _finMovVencidos(){'),
  recorta('function _finMovZerarFiltros(s){'),
  // `const` num script de vm não vira propriedade do contexto — sem isto o teste não
  // enxerga as visões e o invariante 10 nem chega a rodar.
  'globalThis.FIN_MOV_VISOES = FIN_MOV_VISOES;',
].join('\n\n');

const METRICAS = { saldoGeral: 10000, aRepassar: 1600, caixaLivre: 8400, contasCount: 3, stale: [] };

const ctxVm = {
  console,
  Date: DataFixa, Math, JSON, Object, Set, Map, Promise, Number, String, Array, isFinite, parseFloat, parseInt,
  getSupabase: () => fakeSupabase(TABELAS),
  hoje: () => HOJE,
  _finCascataMetricas: async () => METRICAS,
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

  // 3. "recuperado no mês" do card de meta é o MESMO número do KPI de resultado.
  //    Os dois saem de A.receita — o teste trava a fonte única, não a coincidência.
  ok('3 · recuperado no mês = recebido', perto(A.receita, 3200));

  // 4. Rodapé do DRE = KPI de resultado: a soma das categorias tem de fechar com ele.
  const somaCats = A.cats.reduce((s, c) => s + c.valor, 0);
  ok('4 · soma do resultado por categoria = resultado realizado',
    perto(somaCats, A.resultado), `${somaCats} ≠ ${A.resultado}`);

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

  // 7. Despesa recorrente aparece uma vez no mês.
  const aluguel = A.cats.filter(c => c.nome === 'Aluguel');
  ok('7 · despesa recorrente aparece uma vez', aluguel.length === 1 && perto(aluguel[0].valor, -300),
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
    // Contador do chip: o predicado da visão sobre a base.
    const contados = ctx2.rows.filter(l => v.ok(l, ctx2)).length;
    // Lista: o caminho real de filtragem da tela, com o painel de filtros limpo.
    ctxVm._finMovZerarFiltros(ctxVm._finLancCascataState);
    ctxVm._finLancCascataState.visao = v.id;
    const filtrados = ctxVm._finLancCascataFiltrados().length;
    ok(`10 · chip "${v.label}": contador = linhas da lista (${contados})`, contados === filtrados,
      `chip ${contados} × lista ${filtrados}`);
  }
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
  ok('10b · a visão "A repassar" acha o repasse pela operação',
    ctxVm.FIN_MOV_VISOES.find(v => v.id === 'repassar').ok(linhas.find(l => l.id === 8), ctx2) === true);

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
