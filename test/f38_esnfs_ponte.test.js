/*
 * Teste F-38 (assets/js/esnfs-ponte.js) — ponte painel ⇄ extensão do ESNFS (13/09/2026).
 *
 * A emissão de NFS-e passou a ser no ESNFS (extensao/esnfs/), e a única coisa que a
 * extensão não sabe é a BASE da nota: quando o recebimento tem capital do credor, a
 * nota é só sobre o honorário. Este teste prende:
 *   1. esnfsBaseFiscal — honorário × valor cheio × revisão × sem CPF (mesma regra de
 *      api/_emitir-nf.js);
 *   2. o lote copiado sai `Nome | CPF | valor | ref` e a extensão lê a ref de volta;
 *   3. o relatório da extensão (bloco COBRASQ-RESULTADO) é lido, e o fallback pela
 *      tabela Markdown também; o casamento é por ref, ou por CPF+valor só quando único;
 *   4. Faturamento: filtro por período usa metadata.emitida_em, série de 12 meses e
 *      previsão do Simples pela alíquota efetiva; o DAS vence dia 20 do mês seguinte.
 *
 * Como rodar:
 *   node test/f38_esnfs_ponte.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const P = require('../assets/js/esnfs-ponte.js');

// 1. base fiscal
{
  const q = { cpf_cnpj: '091.133.699-03', valor: 4300 };
  assert.deepStrictEqual(P.esnfsBaseFiscal(q, { valor_recebido: 4300, valor_capital: 500, valor_honorario: 3800, repasse_status: 'efetuado' }),
    { pronto: true, base: 3800, tipo: 'honorario', motivo: '' }, 'com capital → honorário');
  assert.deepStrictEqual(P.esnfsBaseFiscal(q, { valor_recebido: 4300, valor_capital: 0, valor_honorario: 0, repasse_status: 'nao_aplica' }),
    { pronto: true, base: 4300, tipo: 'valor_cheio', motivo: '' }, 'sem capital → valor cheio');
  assert.deepStrictEqual(P.esnfsBaseFiscal(q, null), { pronto: true, base: 4300, tipo: 'valor_cheio', motivo: '' }, 'sem operação → valor da fila');
  assert.strictEqual(P.esnfsBaseFiscal(q, { valor_recebido: 4300, valor_capital: 0, repasse_status: 'revisar' }).pronto, false, 'em revisão não emite');
  assert.strictEqual(P.esnfsBaseFiscal({ cpf_cnpj: '', valor: 10 }, null).motivo, 'sem CPF/CNPJ do tomador');
  assert.strictEqual(P.esnfsBaseFiscal(q, { valor_capital: 100, valor_honorario: 0 }).motivo, 'base zero');
  // recebimento à mão (sem fin_operacao) numa cobrança com capital do credor → revisão
  assert.strictEqual(P.esnfsBaseFiscal(q, null, { valor_capital: 500 }).pronto, false);
  assert.ok(/capital do credor/.test(P.esnfsBaseFiscal(q, null, { valor_capital: 500 }).motivo));
  assert.strictEqual(P.esnfsBaseFiscal(q, null, { valor_capital: 0 }).base, 4300, 'sem capital na cobrança → valor pago');
}

// 2. lote → extensão (a extensão lê a ref do 4º campo)
{
  const lote = P.esnfsMontarLote([
    { nome: 'Jessica Maikot Milanez', doc: '09113369903', valor: 3800, ref: 'fila:abc' },
    { nome: 'Fulano | de Tal', doc: '12345678000195', valor: 1234.5, ref: 'manual:m1' },
  ], { quando: new Date(2026, 8, 13, 10, 0) });
  const l = lote.split('\n');
  assert.ok(l[0].startsWith('# COBRASQ'), 'cabeçalho é comentário');
  assert.strictEqual(l[1], 'Jessica Maikot Milanez | 091.133.699-03 | 3800,00 | fila:abc');
  assert.strictEqual(l[2], 'Fulano de Tal | 12.345.678/0001-95 | 1234,50 | manual:m1', 'pipe no nome não quebra a linha');

  // a extensão: absorverColagem aceita "Nome | CPF | Valor | ref"
  const popup = fs.readFileSync(path.join(__dirname, '..', 'extensao', 'esnfs', 'popup.js'), 'utf8');
  assert.ok(/ref = c\[3\] \|\| ''/.test(popup), 'popup.js lê a ref do 4º campo');
  assert.ok(/ref: i\.ref \|\| ''/.test(popup), 'popup.js manda a ref na fila (queue)');
  const content = fs.readFileSync(path.join(__dirname, '..', 'extensao', 'esnfs', 'content.js'), 'utf8');
  assert.ok(content.includes("'--- COBRASQ-RESULTADO v1 ---'"), 'content.js escreve o bloco no relatório');
  assert.ok(/ref: it\.ref \|\| ''/.test(content), 'content.js guarda a ref no resultado');
  new vm.Script(popup); new vm.Script(content); // sintaxe
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extensao', 'esnfs', 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.version, '1.2.0');
}

// 3. resultado ← extensão
{
  const rel = [
    '# Emissão de NFS-e — 13/09/2026 14:00',
    '| # | Tomador | CPF/CNPJ | Valor (R$) | Nota | Status | Observação |',
    '|---|---------|----------|-----------|------|--------|------------|',
    '| 1 | JESSICA MAIKOT MILANEZ | 091.133.699-03 | 3800,00 | 2026/000123 | ✅ emitida | — |',
    '| 2 | FULANO | 123.456.789-09 | 100,00 | — | ❌ falhou | Cidade não encontrada |',
    '',
    '--- COBRASQ-RESULTADO v1 ---',
    'ref;status;nota;cpf;valor;nome;obs',
    'fila:abc;ok;2026/000123;09113369903;3800,00;JESSICA MAIKOT MILANEZ;',
    ';erro;;12345678909;100,00;FULANO;Cidade não encontrada',
    '--- FIM ---',
  ].join('\n');
  const r = P.esnfsParseResultado(rel);
  assert.strictEqual(r.fonte, 'bloco');
  assert.strictEqual(r.itens.length, 2);
  assert.deepStrictEqual(r.itens[0], { ref: 'fila:abc', status: 'ok', nota: '2026/000123', doc: '09113369903', valor: 3800, nome: 'JESSICA MAIKOT MILANEZ', obs: '' });
  assert.strictEqual(r.itens[1].status, 'erro');
  assert.strictEqual(r.itens[1].obs, 'Cidade não encontrada');

  // fallback: só a tabela (relatório antigo / v1.1)
  const semBloco = rel.split('\n--- COBRASQ')[0];
  const t = P.esnfsParseResultado(semBloco);
  assert.strictEqual(t.fonte, 'tabela');
  assert.strictEqual(t.itens.length, 2);
  assert.strictEqual(t.itens[0].ref, '');
  assert.strictEqual(t.itens[0].nota, '2026/000123');
  assert.strictEqual(t.itens[0].valor, 3800);
  assert.strictEqual(t.itens[1].nota, '');

  // casamento
  const pend = [
    { ref: 'fila:abc', doc: '09113369903', valor: 3800 },
    { ref: 'fila:d1', doc: '12345678909', valor: 100 },
    { ref: 'fila:d2', doc: '12345678909', valor: 100 }, // parcela igual → ambíguo sem ref
  ];
  const c = P.esnfsCasarResultado(t.itens, pend);
  assert.strictEqual(c[0].como, 'cpf+valor');
  assert.strictEqual(c[0].pendente.ref, 'fila:abc');
  assert.strictEqual(c[1].como, 'ambiguo', 'duas linhas iguais não casam sozinhas');
  const c2 = P.esnfsCasarResultado(r.itens, pend);
  assert.strictEqual(c2[0].como, 'ref');
  assert.strictEqual(P.esnfsCasarResultado([{ ref: '', doc: '99999999999', valor: 1 }], pend)[0].como, 'sem_par');
  assert.strictEqual(P.esnfsParseResultado('nada aqui').fonte, 'vazio');
}

// 4. faturamento + Simples
{
  const rows = [
    { nf_status: 'emitida', valor: 3800, criada_em: '2026-09-13T10:00:00Z', metadata: { origem: 'esnfs', emitida_em: '2026-09-13', nf_number: '2026/1' } },
    { nf_status: 'emitida', valor: 200, criada_em: '2026-09-01T10:00:00Z', metadata: { emitida_em: '2026-08-31' } }, // data da nota manda
    { nf_status: 'arquivada', valor: 999, criada_em: '2026-09-02T10:00:00Z', metadata: {} },
    { nf_status: 'emitida', valor: 100, criada_em: '2026-07-15T10:00:00Z', metadata: {} }, // sem emitida_em → criada_em
    { nf_status: 'processando', valor: 50, criada_em: '2026-09-05T10:00:00Z', metadata: { resolved: 'emitida', emitida_em: '2026-09-05' } },
  ];
  const set = P.faturamentoFiltrar(rows, '2026-09-01', '2026-09-30');
  assert.deepStrictEqual(set.map(r => r.valor), [3800, 50], 'setembro: só emitidas com data em setembro');
  assert.strictEqual(P.nfNumero(rows[0]), '2026/1');
  const serie = P.faturamentoSerieMensal(rows, '2026-09-30', 3);
  assert.deepStrictEqual(serie, [
    { mes: '2026-07', total: 100, notas: 1 },
    { mes: '2026-08', total: 200, notas: 1 },
    { mes: '2026-09', total: 3850, notas: 2 },
  ]);
  assert.strictEqual(P.simplesPrevisao(3850, '6,00'), 231);
  assert.strictEqual(P.simplesPrevisao(3850, ''), 0);
  assert.strictEqual(P.simplesPrevisao(3850, 'x'), 0);
  const l = P.simplesLancamento('2026-09', 231);
  assert.strictEqual(l.descricao, 'Simples Nacional — DAS de outubro');
  assert.strictEqual(l.data_vencimento, '2026-10-20');
  assert.strictEqual(l.valor, -231);
  assert.strictEqual(l.tipo_movimento, 0);
  assert.deepStrictEqual(l.raw_payload, { origem: 'faturamento_das', competencia: '2026-09' });
  assert.strictEqual(P.simplesLancamento('2026-12', 10).data_vencimento, '2027-01-20', 'dezembro vira janeiro');
}

// 5. a tela: rota Asaas sem botão; Faturamento registrada como aba
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(!/onclick="nfaEmitirLote\(\)"/.test(html), 'botão "Emitir lote" (Asaas) saiu da tela');
  assert.ok(!/onclick="nfaEmitirTeste\(\)"/.test(html), 'botão "Emitir 1 de teste" (Asaas) saiu da tela');
  assert.ok(html.includes('/assets/js/esnfs-ponte.js'), 'index.html carrega a ponte');
  assert.ok(/FIN_CASCATA_TABS = \[[^\]]*'faturamento'/.test(html), 'faturamento é aba válida');
  assert.ok(/FIN_TABS_COM_PERIODO = \[[^\]]*'faturamento'/.test(html), 'faturamento obedece ao seletor de período');
  assert.ok(/\{id:'faturamento', label:'Faturamento'\}/.test(html), 'faturamento na barra');
  assert.ok(/else if\(tab==='faturamento'\) renderFinFaturamento\(el\);/.test(html), 'router chama renderFinFaturamento');
  const nf = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'nf.js'), 'utf8');
  assert.ok(!/nffEmitirSel\(\)'/.test(nf) && !/`nffEmitir\(\[/.test(nf), 'fila não chama mais a emissão pelo Asaas');
  assert.ok(nf.includes('nffCopiarLoteSel()') && nf.includes('nffImportarResultado()'), 'fila tem copiar lote e importar resultado');
  assert.ok(/from\('fin_lancamento'\)[\s\S]{0,400}\.eq\('tipo_movimento',1\)\.eq\('status',1\)\.not\('cobranca_id','is',null\)/.test(nf), 'fila nasce dos lançamentos de entrada pagos com cobrança');
  assert.ok(/from\('devedores'\)/.test(nf), 'tomador vem do devedor da cobrança');
  assert.ok(/function nffGarantirLinha/.test(nf), 'linha de decisão criada só ao decidir');
}

console.log('F-38 ok — ponte ESNFS: base fiscal, lote, resultado, faturamento, DAS.');
