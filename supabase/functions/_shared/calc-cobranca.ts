// Porta fiel do motor de cálculo "modo cobrança" usado em templates/calc-engine.js
// e crm.html (_calcCobrancaSimples) — mesma fórmula, mesmas constantes padrão.
//
// ATENÇÃO: jurosMensal e multaPct são configuráveis por quem gerencia o
// sistema (index.html → Configurações → Parâmetros de cálculo), mas esse
// valor hoje só existe no localStorage do navegador (chave 'cobrasq_v6'),
// não no Supabase — não há como este código server-side ler o valor ao
// vivo. Por isso usamos aqui os mesmos valores PADRÃO do sistema
// (TAXA_JUROS_MENSAL/MULTA_PCT em crm.html). Se algum dia esses parâmetros
// forem migrados pra uma tabela de config no Supabase, atualizar aqui pra
// ler de lá em vez do default.

export const COB = {
  correcaoMensal: 0.08 / 12,
  jurosMensal: 0.01,
  multaPct: 0.02,
  taxaServ: 0.30,
  boletoJuros: 0.0299,
  boletoFixo: 6,
  parcelaMin: 256,
  parcelaMax: 12,
  cartaoMult: 1 + (0.0499 * 12) + 0.05,
};

function mesesEntre(d1: Date, d2: Date): number {
  return Math.max(0, (d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24 * 30.4375));
}

function parseDataLocal(s: string | null): Date | null {
  if (!s) return null;
  const p = String(s).split('-');
  if (p.length < 3) return null;
  const d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  return isNaN(d.getTime()) ? null : d;
}

export interface BoletoOption { n: number; parcela: number; total: number; }

export interface CalcCobranca {
  valorOriginal: number;
  totalAvista: number;
  boletoOptions: BoletoOption[];
  boleto12: BoletoOption | null;
  cartao12Total: number;
  cartao12Parcela: number;
  fixo?: boolean;
}

// VALOR FIXO: casos que já têm o valor atualizado definido manualmente (ex.:
// dívida em fase judicial — cumprimento de sentença, execução — onde o valor
// segue cálculo judicial próprio, não a fórmula de cobrança extrajudicial
// daqui, e não tem "vencimento" no sentido de parcela recorrente). Não
// calcula NADA, não gera opção de parcelamento — só embala o valor já dado.
// Sinal de quando usar: divida.vencimento ausente MAS divida.totalAvista
// presente (dívida já "madura"/virou ação, sem data de vencimento futura).
export function valorFixo(totalAvista: number): CalcCobranca {
  return {
    valorOriginal: totalAvista,
    totalAvista,
    boletoOptions: [],
    boleto12: null,
    cartao12Total: totalAvista,
    cartao12Parcela: totalAvista,
    fixo: true,
  };
}

// mesma fórmula de templates/calc-engine.js#calcularCobranca, com
// aplicarMulta=true e aplicarTaxa=true (uso padrão em cobrança extrajudicial).
export function calcularCobranca(valorOriginal: number, vencimentoISO: string, hojeISO: string): CalcCobranca | null {
  const dV = parseDataLocal(vencimentoISO);
  const dH = parseDataLocal(hojeISO);
  if (!dV || !dH || !(valorOriginal > 0)) return null;

  const meses = mesesEntre(dV, dH);
  const correcao = valorOriginal * COB.correcaoMensal * meses;
  const valorCorrigido = valorOriginal + correcao;
  const juros = valorCorrigido * COB.jurosMensal * meses;
  const multa = valorCorrigido * COB.multaPct;
  const subtotal = valorCorrigido + juros + multa;
  const taxa = subtotal * COB.taxaServ;
  const total = Math.ceil(subtotal + taxa);

  const boletoOptions: BoletoOption[] = [];
  for (let n = 1; n <= COB.parcelaMax; n++) {
    let vp: number;
    if (n === 1) vp = total;
    else {
      const i = COB.boletoJuros;
      const f = (i * Math.pow(1 + i, n)) / (Math.pow(1 + i, n) - 1);
      vp = total * f;
    }
    const arred = Math.ceil(vp + COB.boletoFixo);
    if (arred >= COB.parcelaMin) boletoOptions.push({ n, parcela: arred, total: arred * n });
  }
  const boleto12 = boletoOptions.find((o) => o.n === 12) || boletoOptions[boletoOptions.length - 1] || null;
  const cartao12Total = Math.ceil(total * COB.cartaoMult);
  const cartao12Parcela = Math.ceil(cartao12Total / 12);

  return { valorOriginal, totalAvista: total, boletoOptions, boleto12, cartao12Total, cartao12Parcela };
}
