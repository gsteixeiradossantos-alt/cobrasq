// Parse tolerante de valor monetário vindo de `cobrancas.divida` (jsonb).
//
// Em 25/09/2026, ~364 cobranças tinham `divida.valorOriginal`/`totalAvista` como
// STRING no formato BR ("1.924,80") — sobretudo importadas do Astrea. As edge
// functions faziam `Number(...)`, que dá NaN para isso: o carlos-iniciar recusava
// ("dívida não calculada"), a Bia/Carlos ficava sem valor e o carlos-teste caía
// no cenário FICTÍCIO (R$ 2.400) com o nome do devedor real.
//
// Aceita: número; "1.924,80" / "1924,80" / "R$ 1.924,80" (BR); "1924.80" /
// "1386.00" (ponto decimal); "1.924" / "12.345.678" (só milhar BR). Vazio,
// null ou lixo → 0 (os chamadores já tratam 0 como "sem valor").
export function parseValorBR(v: unknown): number {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v ?? '').trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (!s) return 0;
  const neg = /^-/.test(s);
  s = s.replace(/[^\d.,]/g, '');
  if (!s) return 0;
  if (s.includes(',')) {
    // vírgula = decimal BR; pontos = milhar
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    // "1.924" / "12.345.678": ponto só como milhar
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  if (!isFinite(n)) return 0;
  return neg ? -n : n;
}
