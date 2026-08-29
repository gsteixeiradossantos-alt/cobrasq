// api/_data.js — data de calendário no fuso de Curitiba, para o backend.
//
// O runtime da Vercel roda em UTC. Quem escreve `new Date().toISOString().slice(0,10)`
// num handler está gravando a data de UTC, não a do escritório: das 21h à meia-noite
// (BRT) o servidor já virou o dia. Na prática isso datava no dia seguinte:
//   · o `effectiveDate` da nota fiscal (documento fiscal com a data errada);
//   · a data do Pix e a do comprovante de repasse enviado ao cedente;
//   · o vencimento das parcelas criadas pelo emitir-acordo;
//   · o `recebido_em` de um pagamento sem data vinda do Asaas.
//
// Diferente do frontend (que tem o fuso do navegador e usa `isoLocal`), aqui o fuso
// precisa ser DECLARADO — o servidor não tem um. Por isso Intl com timeZone explícito,
// e não aritmética de offset: assim continua certo se o Brasil algum dia voltar a ter
// horário de verão.
//
// `toISOString()` COMPLETO continua correto para carimbo de instante (created_at,
// updated_at, humano_ate): esses são timestamptz e devem ser UTC mesmo.

const FUSO_BR = 'America/Sao_Paulo';

// en-CA formata como AAAA-MM-DD. Com timeZone explícito, o fuso do servidor não entra.
const _fmtBR = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO_BR, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Data de calendário (AAAA-MM-DD) em Curitiba para um instante qualquer. */
function isoBR(d) {
  const x = (d instanceof Date) ? d : new Date(d == null ? Date.now() : d);
  if (isNaN(x.getTime())) return '';
  return _fmtBR.format(x);
}

/** Hoje em Curitiba. Substitui `new Date().toISOString().slice(0,10)`. */
function hojeBR() {
  return isoBR(new Date());
}

/**
 * Hoje ± n dias, em Curitiba. `base` opcional (Date, ISO ou ms) para contar de outro
 * ponto. O Brasil não tem horário de verão desde 2019, então somar 86.400.000 ms por
 * dia é exato; se voltar a ter, o Intl acima é que garante o dia certo.
 */
function addDiasBR(n, base) {
  const ini = base == null ? Date.now() : (base instanceof Date ? base.getTime() : new Date(base).getTime());
  if (isNaN(ini)) return '';
  return isoBR(new Date(ini + (Number(n) || 0) * 86400000));
}

module.exports = { FUSO_BR, isoBR, hojeBR, addDiasBR };
