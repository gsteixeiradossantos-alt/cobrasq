/* ============================================================================
 * calc-engine.js — Matriz de cálculo COBRASQ (motor único de dívida)
 * ----------------------------------------------------------------------------
 * FONTE ÚNICA das contas de dívida usadas pelo Faturamento (index.html) e pelo
 * CRM (crm.html). Antes, cada tela tinha sua PRÓPRIA cópia (idêntica) do motor
 * jurídico e da conta de cobrança, além de tabelas de índice duplicadas — mudar
 * uma fórmula ou o índice do mês exigia editar todas. Agora: muda AQUI, replica
 * em todo lugar. As telas viram "filiais" finas que só chamam este motor.
 *
 * PURO: sem DOM, sem rede. Dual-mode (browser global `CalcEngine` + CommonJS
 * para os testes Node) — mesmo padrão de templates/termo-engine.js.
 *
 * NÃO incluído nesta fase (algoritmo/série diferentes — exigem decisão e
 * MUDAM número; ver docs/calc/MATRIZ.md → fase 2):
 *   - index.html  calcDividaAtualizada / CALC_INPC_MENSAL  (execução; série INPC
 *     desde 2020, garantia-STJ por fator acumulado, juros pró-rata por dias)
 *   - calc-juridica.html calcularPrincipal / segmentarPorMes (pró-rata-die por
 *     segmento de mês — mais preciso que dias/30)
 * ========================================================================== */
(function (global) {
  'use strict';

  // ── Tabelas de índice mensal — variação % do mês. FONTE ÚNICA. ──────────────
  // Atualizar AQUI 1x por mês (antes: 13 cópias em 3 arquivos). INPC é o índice
  // da Tabela Prática do TJ-PR (Súmula 459 STJ); TJPR é série própria do tribunal.
  // SELIC inclui jun/2026 PARCIAL (até dia 09) — só entra em cálculos com data
  // final em julho/2026+ (mês corrente nunca é aplicado antes de fechar).
  const TABELAS = {
    INPC: {
      '2024-05': 0.46, '2024-06': 0.25, '2024-07': 0.26, '2024-08': -0.14,
      '2024-09': 0.48, '2024-10': 0.61, '2024-11': 0.33, '2024-12': 0.48,
      '2025-01': 0.00, '2025-02': 1.48, '2025-03': 0.51, '2025-04': 0.48,
      '2025-05': 0.35, '2025-06': 0.23, '2025-07': 0.21, '2025-08': -0.21,
      '2025-09': 0.52, '2025-10': 0.03, '2025-11': 0.03, '2025-12': 0.21,
      '2026-01': 0.39, '2026-02': 0.56, '2026-03': 0.91, '2026-04': 0.81
    },
    IPCA: {
      '2024-05': 0.46, '2024-06': 0.21, '2024-07': 0.38, '2024-08': -0.02,
      '2024-09': 0.44, '2024-10': 0.56, '2024-11': 0.39, '2024-12': 0.52,
      '2025-01': 0.16, '2025-02': 1.31, '2025-03': 0.56, '2025-04': 0.43,
      '2025-05': 0.26, '2025-06': 0.24, '2025-07': 0.26, '2025-08': -0.11,
      '2025-09': 0.48, '2025-10': 0.09, '2025-11': 0.18, '2025-12': 0.33,
      '2026-01': 0.33, '2026-02': 0.70, '2026-03': 0.88, '2026-04': 0.67
    },
    SELIC: {
      '2024-05': 0.83, '2024-06': 0.79, '2024-07': 0.91, '2024-08': 0.87,
      '2024-09': 0.84, '2024-10': 0.93, '2024-11': 0.79, '2024-12': 0.93,
      '2025-01': 1.01, '2025-02': 0.99, '2025-03': 0.96, '2025-04': 1.06,
      '2025-05': 1.14, '2025-06': 1.10, '2025-07': 1.28, '2025-08': 1.16,
      '2025-09': 1.22, '2025-10': 1.28, '2025-11': 1.05, '2025-12': 1.22,
      '2026-01': 1.16, '2026-02': 1.00, '2026-03': 1.21, '2026-04': 1.09,
      '2026-05': 1.07, '2026-06': 0.08 /* parcial até dia 09 */
    },
    TJPR: {
      '2024-05': 0.67, '2024-06': 0.38, '2024-07': 0.55, '2024-08': -0.01,
      '2024-09': 0.76, '2024-10': 1.07, '2024-11': 0.76, '2024-12': 0.68,
      '2025-01': 0.06, '2025-02': 1.24, '2025-03': 0.01, '2025-04': 0.39,
      '2025-05': -0.25, '2025-06': -0.79, '2025-07': 0.07, '2025-08': -0.01,
      '2025-09': 0.44, '2025-10': 0.00, '2025-11': 0.02, '2025-12': 0.15,
      '2026-01': 0.29, '2026-02': -0.14, '2026-03': 1.02, '2026-04': 1.61
    }
  };

  // Índices atualizados até (AAAA-MM). Avisar admin para atualizar mensalmente.
  const INDICES_ATE = '2026-06';

  function _num(v) { return typeof v === 'number' ? v : (parseFloat(v) || 0); }

  // ── Correção monetária composta, mês fechado ────────────────────────────────
  // Aplica o índice de cada mês CHEIO entre dataIni e dataFim (o mês corrente só
  // entra quando seu último dia já passou de dataFim). Garantia STJ é aplicada
  // por quem chama (juridica()), não aqui. Porta fiel de _petCorrecaoMensal /
  // _pecaAplicarCorrecaoMensal (eram idênticos nos dois arquivos).
  function correcaoMensal(valorInicial, dataIni, dataFim, indice) {
    const tabela = TABELAS[indice] || TABELAS.INPC;
    let valor = valorInicial;
    let cursor = new Date(dataIni.getFullYear(), dataIni.getMonth(), dataIni.getDate());
    let mesesAplicados = 0;
    while (true) {
      const fimDoMes = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
      if (fimDoMes >= dataFim) break;
      const chave = cursor.getFullYear() + '-' + String(cursor.getMonth() + 1).padStart(2, '0');
      const pct = (chave in tabela) ? tabela[chave] : 0;
      valor = valor * (1 + pct / 100);
      mesesAplicados++;
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
    return { valorCorrigido: valor, mesesAplicados };
  }

  // ── Conta JURÍDICA (peça / memorial) ────────────────────────────────────────
  // Correção composta + juros simples pró-rata (dias/30) sobre o atualizado +
  // multa sobre o atualizado + honorários sobre (atualizado+juros+multa) +
  // garantia STJ (valor atualizado nunca menor que o nominal).
  // Porta fiel de _petCalcJuridica (index) == _calcJuridicaMemorial (crm).
  function juridica(valorNominal, dataIni, dataFim, indice, multaPct, honPct, jurosMensalPct) {
    const corr = correcaoMensal(valorNominal, dataIni, dataFim, indice);
    const valorAtualizado = Math.max(corr.valorCorrigido, valorNominal);
    const aplicouGarantiaSTJ = corr.valorCorrigido < valorNominal;
    const dias = (dataFim - dataIni) / (1000 * 60 * 60 * 24);
    const mesesPRO = dias / 30;
    const juros = valorAtualizado * (_num(jurosMensalPct) / 100) * mesesPRO;
    const multa = valorAtualizado * (_num(multaPct) / 100);
    const honorarios = (valorAtualizado + juros + multa) * (_num(honPct) / 100);
    const total = valorAtualizado + juros + multa + honorarios;
    return {
      valorNominal, indice, valorAtualizado, aplicouGarantiaSTJ,
      mesesPRO: Math.round(mesesPRO * 100) / 100, mesesCorrigidos: corr.mesesAplicados,
      juros, multa, honorarios, total,
      multaPct: _num(multaPct), honPct: _num(honPct), jurosMensalPct: _num(jurosMensalPct),
      indice_ate: INDICES_ATE
    };
  }

  // ── Conta COBRANÇA — núcleo (valor extrajudicial à vista) ────────────────────
  // O CHAMADOR informa `meses` (cada tela conta do seu jeito: o CRM usa fração
  // por ms; o painel arredonda pra dia) e TODOS os parâmetros, para preservar
  // exatamente o número de cada origem. Correção linear simples + juros sobre o
  // corrigido + multa sobre o corrigido + taxa de serviço sobre o subtotal,
  // total arredondado para cima. Porta fiel do núcleo de calcDividaCobranca
  // (index) e _calcCobrancaSimples (crm). Parcelamento (boleto/cartão) fica na
  // filial que precisa (hoje só o CRM).
  function cobranca(opts) {
    opts = opts || {};
    const valorOriginal = _num(opts.valorOriginal);
    const meses = _num(opts.meses);
    const correcaoMensalPct = _num(opts.correcaoMensal); // taxa mensal já pronta (ex.: 0.08/12)
    const jurosMensal = _num(opts.jurosMensal);
    const multaPct = _num(opts.multaPct);
    const taxaServico = _num(opts.taxaServico);
    const aplicarMulta = opts.aplicarMulta !== false;     // default true
    const aplicarTaxa = opts.aplicarTaxa !== false;       // default true

    const correcao = valorOriginal * correcaoMensalPct * meses;
    const valorCorrigido = valorOriginal + correcao;
    const juros = valorCorrigido * jurosMensal * meses;
    const multa = aplicarMulta ? valorCorrigido * multaPct : 0;
    const subtotal = valorCorrigido + juros + multa;
    const taxa = aplicarTaxa ? subtotal * taxaServico : 0;
    const total = Math.ceil(subtotal + taxa);
    return { meses, correcao, valorCorrigido, juros, multa, subtotal, taxa, total };
  }

  const CalcEngine = {
    TABELAS: TABELAS,
    INDICES_ATE: INDICES_ATE,
    correcaoMensal: correcaoMensal,
    juridica: juridica,
    cobranca: cobranca,
    _version: '1.0.0'
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CalcEngine;
  global.CalcEngine = CalcEngine;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
