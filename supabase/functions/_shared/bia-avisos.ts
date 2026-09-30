// Textos dos avisos de boleto da Bia ANTES do vencimento (3 dias antes, véspera
// e dia) — separados do worker para serem testáveis e revisados num lugar só.
// Agenda e dias úteis: ./dias-uteis.ts. Quem ainda está no prazo não é
// inadimplente: aqui nunca há ameaça nem cobrança de atraso.
//
// `jaCobrado` = o devedor já levou cobrança de atraso deste boleto e o
// vencimento foi mudado depois (caso José Lentz, 21/09/2026: 2 cobranças e em
// seguida "passando só pra lembrar... vence em 80 dias"). Para ele o aviso fala
// do NOVO vencimento combinado.

const SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

function diaSemana(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return SEMANA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
function ddmm(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}`;
}
function brMoney(v: unknown): string {
  const n = Number(v) || 0;
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 864e5);
}
// "amanhã, dia 22/10" | "na segunda-feira, dia 26/10"
function quando(hoje: string, dia: string): string {
  if (diasEntre(hoje, dia) === 1) return `amanhã, dia ${ddmm(dia)}`;
  const s = diaSemana(dia);
  const art = s === 'sábado' || s === 'domingo' ? 'no' : 'na';
  return `${art} ${s}, dia ${ddmm(dia)}`;
}

export type AvisoPreVenc = {
  etapa: 'antecipado' | 'vespera' | 'dia';
  sig: string;
  nome: string;        // nome completo ou vazio
  valor: unknown;
  venc: string;        // vencimento do boleto (Asaas)
  vencEf: string;      // vencimento de fato (dia útil)
  hoje: string;
  url: string;
  jaCobrado: boolean;
};

export function textosPreVencimento(a: AvisoPreVenc): string[] {
  const primeiro = String(a.nome || '').trim().split(/\s+/)[0] || '';
  const ola = primeiro ? `Oi ${primeiro}, tudo bem?` : 'Oi, tudo bem?';
  const val = brMoney(a.valor);
  const link = a.url ? `\n${a.url}` : '';
  const prorrogado = a.vencEf !== a.venc.slice(0, 10);
  let corpo: string[];

  if (a.jaCobrado) {
    if (a.etapa === 'dia') {
      corpo = [
        `Hoje é o novo vencimento da sua parcela de R$ ${val}.`,
        `O boleto está aqui:${link}`,
        `Se já pagou, pode desconsiderar.`,
      ];
    } else {
      corpo = [
        `Passando pra lembrar do novo vencimento da sua parcela de R$ ${val}: ${quando(a.hoje, a.vencEf)}.`,
        `O boleto atualizado está aqui:${link}`,
        `Conto com você nessa data. Se já pagou, pode desconsiderar.`,
      ];
    }
  } else if (a.etapa === 'dia') {
    corpo = [
      prorrogado
        ? `Sua parcela de R$ ${val} venceu ${diaSemana(a.venc) === 'sábado' || diaSemana(a.venc) === 'domingo' ? 'no' : 'na'} ${diaSemana(a.venc)} (${ddmm(a.venc)}), que não foi dia útil, então dá pra pagar hoje.`
        : `Sua parcela de R$ ${val} vence hoje.`,
      `Pra deixar em dia, é só usar o link:${link}`,
      `Se já pagou, pode desconsiderar.`,
    ];
  } else if (a.etapa === 'vespera') {
    corpo = [
      `Sua parcela de R$ ${val} vence ${quando(a.hoje, a.vencEf)}.`,
      `O boleto está aqui:${link}`,
      `Se já pagou, pode desconsiderar.`,
    ];
  } else {
    corpo = [
      `Passando pra lembrar: sua parcela de R$ ${val} vence ${quando(a.hoje, a.vencEf)}.`,
      `Se quiser adiantar, o boleto está aqui:${link}`,
      `Se já pagou, pode desconsiderar.`,
    ];
  }
  return [`${a.sig}\n${ola}`, ...corpo];
}
