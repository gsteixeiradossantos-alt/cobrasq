/*
 * Teste F-59 (Financeiro — a busca acha o credor).
 *
 * Digitar o nome do credor ("Oxipar") na busca do Financeiro tem de trazer os lançamentos
 * da carteira dele mesmo quando o nome não está na descrição — por qualquer um dos
 * caminhos com que a linha mostra o credor: credor_id, cedente_id,
 * cobranca_id → cobrancas.cliente_id e fin_operacao.credor_id. E tem de ser no servidor,
 * dentro do período (R-21).
 *
 * Roda contra o código real de _finLancBuscaPorCredor, recortado do index.html, com um
 * Supabase de mentira.
 *
 *   node test/f59_fin_busca_credor.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const marca = 'async function _finLancBuscaPorCredor(';
const i = HTML.indexOf(marca);
assert.ok(i >= 0, 'não achei _finLancBuscaPorCredor no index.html');
const j = HTML.indexOf('\n}\n', i);
const fonte = HTML.slice(i, j + 2);

// O carregador chama a busca por credor e junta com a da descrição.
const carregador = HTML.slice(HTML.indexOf('async function _finLancCascataCarregar('));
assert.ok(/_finLancBuscaPorCredor\(sb, termo, consultaBase, ordenaLimita/.test(carregador.slice(0, 6000)),
  'o carregador não usa _finLancBuscaPorCredor');

const TAB = {
  clientes: [
    { id: 'c-oxi', nome: 'Oxipar Oxigênio Ltda', nome_fantasia: 'Oxipar' },
    { id: 'c-fan', nome: 'Razão Qualquer', nome_fantasia: 'Oxipar Filial' },
    { id: 'c-out', nome: 'Outro Credor', nome_fantasia: null },
  ],
  cobrancas: [ { id: 'cob1', cliente_id: 'c-oxi' }, { id: 'cob2', cliente_id: 'c-out' } ],
  fin_operacao: [ { credor_id: 'c-oxi', lancamento_receita_id: 50, lancamento_despesa_id: 51 } ],
  fin_lancamento: [
    { id: 1, descricao: 'Alvará TJ-PR — Alex', data_competencia: '2026-09-10', credor_id: null, cedente_id: null, cobranca_id: 'cob1' },
    { id: 2, descricao: 'Repasse', data_competencia: '2026-09-12', credor_id: 'c-oxi', cedente_id: null, cobranca_id: null },
    { id: 3, descricao: 'Algo', data_competencia: '2026-09-13', credor_id: null, cedente_id: 'c-fan', cobranca_id: null },
    { id: 50, descricao: 'Recebimento', data_competencia: '2026-09-14', credor_id: null, cedente_id: null, cobranca_id: null },
    { id: 51, descricao: 'Repasse antigo', data_competencia: '2026-08-01', credor_id: null, cedente_id: null, cobranca_id: null },
    { id: 9, descricao: 'De outro', data_competencia: '2026-09-15', credor_id: 'c-out', cedente_id: null, cobranca_id: 'cob2' },
  ],
};

function consulta(tabela) {
  const filtros = [];
  const q = {
    select() { return q; },
    filter(col, op, re) { filtros.push(r => new RegExp(re, 'i').test(String(r[col] || ''))); return q; },
    ilike(col, pat) { const t = pat.replace(/%/g, '').toLowerCase(); filtros.push(r => String(r[col] || '').toLowerCase().includes(t)); return q; },
    in(col, vals) { filtros.push(r => vals.includes(r[col])); return q; },
    gte(col, v) { filtros.push(r => String(r[col]) >= v); return q; },
    lte(col, v) { filtros.push(r => String(r[col]) <= v); return q; },
    order() { return q; },
    limit() { return q; },
    then(ok, err) { return Promise.resolve({ data: TAB[tabela].filter(r => filtros.every(f => f(r))), error: null }).then(ok, err); },
  };
  return q;
}
const sb = { from: consulta };
const ctx = { _finBuscaRegexSemAcento: t => t, Promise, Set, Map };
vm.createContext(ctx);
vm.runInContext(fonte, ctx);

const consultaBase = () => sb.from('fin_lancamento').select('*').gte('data_competencia', '2026-09-01').lte('data_competencia', '2026-09-30');
const ordenaLimita = c => c.order().limit();
const emBlocos = arr => { const o = []; for (let k = 0; k < arr.length; k += 300) o.push(arr.slice(k, k + 300)); return o; };
const lerBlocos = (blocos, f) => Promise.all(blocos.map(b => f(b).then(r => r.data || []))).then(p => p.flat());

(async () => {
  const achados = await ctx._finLancBuscaPorCredor(sb, 'oxipar', consultaBase, ordenaLimita, true, emBlocos, lerBlocos);
  const ids = [...new Set(achados.map(r => r.id))].sort((a, b) => a - b);
  assert.deepStrictEqual(ids, [1, 2, 3, 50], 'deveria achar por cobrança, credor_id, cedente_id (fantasia) e operação — só no período');

  const semCedente = await ctx._finLancBuscaPorCredor(sb, 'oxipar', consultaBase, ordenaLimita, false, emBlocos, lerBlocos);
  assert.ok(!semCedente.some(r => r.id === 3), 'sem a coluna cedente_id não pode filtrar por ela');

  const nada = await ctx._finLancBuscaPorCredor(sb, 'inexistente', consultaBase, ordenaLimita, true, emBlocos, lerBlocos);
  assert.strictEqual(nada.length, 0, 'termo sem credor não traz nada');

  console.log('F-59 ok: a busca do Financeiro acha o credor pelos quatro caminhos, dentro do período.');
})().catch(e => { console.error(e); process.exit(1); });
