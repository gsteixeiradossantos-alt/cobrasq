// Dias úteis bancários e agenda dos avisos de boleto da Bia (antes de vencer).
//
// Regra do Gustavo (30/09/2026): a Bia avisa 3 dias antes, na véspera e no dia,
// SEMPRE em dia útil. Boleto que vence no sábado, domingo ou feriado prorroga
// para o próximo dia útil — então o "dia" é esse dia útil, e a "véspera" é o dia
// útil anterior a ele (vence segunda -> véspera na sexta; vence sábado -> sexta
// e segunda; vence em feriado -> dia útil anterior e dia útil posterior).
//
// Feriados: só os NACIONAIS (os que prorrogam boleto em qualquer banco). Conferido
// contra https://brasilapi.com.br/api/feriados/v1/2026 e /2027 em 30/09/2026 —
// ver test/f51_bia_avisos_dias_uteis.test.js. Feriado municipal fica de fora.
//
// Datas são strings 'YYYY-MM-DD' (calendário, sem fuso), como vêm do Asaas.

function toUTC(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fromUTC(dt: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}
export function somarDias(iso: string, n: number): string {
  const dt = toUTC(iso);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromUTC(dt);
}

// Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher, calendário gregoriano).
function pascoa(ano: number): string {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

const cacheFeriados = new Map<number, Set<string>>();
export function feriadosNacionais(ano: number): Set<string> {
  const c = cacheFeriados.get(ano);
  if (c) return c;
  const p = pascoa(ano);
  const s = new Set<string>([
    `${ano}-01-01`, `${ano}-04-21`, `${ano}-05-01`, `${ano}-09-07`,
    `${ano}-10-12`, `${ano}-11-02`, `${ano}-11-15`, `${ano}-11-20`, `${ano}-12-25`,
    somarDias(p, -48), somarDias(p, -47), // Carnaval (segunda e terça)
    somarDias(p, -2),                     // Sexta-feira Santa
    somarDias(p, 60),                     // Corpus Christi
  ]);
  cacheFeriados.set(ano, s);
  return s;
}

export function ehDiaUtil(iso: string): boolean {
  const wd = toUTC(iso).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  return !feriadosNacionais(Number(iso.slice(0, 4))).has(iso.slice(0, 10));
}
// primeiro dia útil >= iso
export function diaUtilEmOuDepois(iso: string): string {
  let d = iso.slice(0, 10);
  while (!ehDiaUtil(d)) d = somarDias(d, 1);
  return d;
}
// último dia útil <= iso
export function diaUtilEmOuAntes(iso: string): string {
  let d = iso.slice(0, 10);
  while (!ehDiaUtil(d)) d = somarDias(d, -1);
  return d;
}
// Vencimento de fato: boleto que vence em dia não útil prorroga para o próximo.
export function vencimentoEfetivo(venc: string): string {
  return diaUtilEmOuDepois(venc);
}

export type AgendaAvisos = { vencEf: string; vespera: string; antecipado: string | null };
// antecipado = N dias corridos antes do vencimento efetivo, recuado para dia útil;
// some (null) se cair no mesmo dia da véspera ou depois dela — um aviso só.
export function agendaAvisos(venc: string, antecedencia = 3): AgendaAvisos {
  const vencEf = vencimentoEfetivo(venc);
  const vespera = diaUtilEmOuAntes(somarDias(vencEf, -1));
  let antecipado: string | null = antecedencia > 1 ? diaUtilEmOuAntes(somarDias(vencEf, -antecedencia)) : null;
  if (antecipado && antecipado >= vespera) antecipado = null;
  return { vencEf, vespera, antecipado };
}

export type EtapaPreVenc =
  | { etapa: 'vencido' }                         // passou do dia: régua de cobrança assume
  | { etapa: 'dia'; proximo: string }            // hoje é o vencimento efetivo
  | { etapa: 'vespera'; proximo: string }
  | { etapa: 'antecipado'; proximo: string }
  | { etapa: 'aguardar'; proximo: string };      // cedo demais: só reagenda, não envia
// `proximo` = data (YYYY-MM-DD) do próximo passo da régua depois deste.
export function etapaPreVencimento(venc: string, hoje: string, antecedencia = 3): EtapaPreVenc {
  const a = agendaAvisos(venc, antecedencia);
  if (hoje > a.vencEf) return { etapa: 'vencido' };
  if (hoje === a.vencEf) return { etapa: 'dia', proximo: diaUtilEmOuDepois(somarDias(a.vencEf, 1)) };
  if (hoje >= a.vespera) return { etapa: 'vespera', proximo: a.vencEf };
  if (a.antecipado && hoje >= a.antecipado) return { etapa: 'antecipado', proximo: a.vespera };
  return { etapa: 'aguardar', proximo: a.antecipado || a.vespera };
}

// 09h de Brasília do dia `iso` (a régua só sai em horário comercial).
export function noveHorasBRT(iso: string): string {
  return new Date(Date.parse(iso.slice(0, 10) + 'T12:00:00Z')).toISOString();
}

// n-ésimo dia útil depois de `iso` (prazo final da Bia: 2 dias úteis).
export function somarDiasUteis(iso: string, n: number): string {
  let d = iso.slice(0, 10);
  for (let i = 0; i < n; i++) d = diaUtilEmOuDepois(somarDias(d, 1));
  return d;
}
