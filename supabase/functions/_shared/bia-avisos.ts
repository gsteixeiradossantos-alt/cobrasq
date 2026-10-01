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
  const ola = saudacao(a.nome);
  const val = brMoney(a.valor);
  const url = a.url || '';
  const prorrogado = a.vencEf !== a.venc.slice(0, 10);
  const fecho = 'Qualquer dúvida, fico à disposição!';
  // textos aprovados pelo Gustavo em 30/09/2026 (página de aprovação, p01–p06)
  if (a.etapa === 'dia' && !prorrogado) {
    // p03 / p06: o dia do vencimento é igual para quem já foi cobrado
    return [
      `${a.sig}\n${ola} Sua parcela de R$ ${val} vence hoje.`,
      `Pague via Boleto ou PIX clicando no link a seguir: ${url}`,
      fecho,
    ];
  }
  if (a.etapa === 'dia') {
    // p04: venceu em sábado/domingo/feriado e o boleto vale hoje
    const s = diaSemana(a.venc);
    return [
      `${a.sig}\n${ola} Sua parcela de R$ ${val} venceu ${s === 'sábado' || s === 'domingo' ? 'no' : 'na'} ${s} (${ddmm(a.venc)}), que não foi dia útil, então dá pra pagar hoje.`,
      `Pra deixar em dia, é só usar o link:\n${url}`,
      fecho,
    ];
  }
  if (a.jaCobrado) {
    // p05: já levou cobrança de atraso e o vencimento foi mudado para frente
    return [
      `${a.sig}\n${ola} Passando pra lembrar do novo vencimento da sua parcela de R$ ${val}: ${quando(a.hoje, a.vencEf)}.`,
      `O boleto atualizado está aqui: ${url}`,
      `Conto com você nessa data. ${fecho}`,
    ];
  }
  if (a.etapa === 'vespera') {
    // p02: sem link, por decisão dele
    return [
      `${a.sig}\n${ola} Passando apenas para lembrar que a sua parcela de R$ ${val} vencerá ${quando(a.hoje, a.vencEf)}.`,
      `Efetue o pagamento na data correta e evite a cobrança de juros e multa. ${fecho}`,
    ];
  }
  // p01: 3 dias (úteis) antes
  return [
    `${a.sig}\n${ola} Passando pra lembrar: sua parcela de R$ ${val} vence ${quando(a.hoje, a.vencEf)}.`,
    `Se quiser adiantar, o boleto está aqui:\n${url}`,
    fecho,
  ];
}

function saudacao(nome: string): string {
  const primeiro = String(nome || '').trim().split(/\s+/)[0] || '';
  return primeiro ? `Oi ${primeiro}, tudo bem?` : 'Oi, tudo bem?';
}

// ===== Cobrança de boleto JÁ VENCIDO (p07, p09, p10, p11) =====
// Nenhum texto cita negativação nem protesto (decisão de 30/09/2026). A linha de
// "N boletos em aberto" só entra na de 7 dias e na de prazo final.
export type CobrancaAtraso = {
  tipo: 'primeira' | 'sete_dias' | 'prazo_final' | 'promessa_quebrada';
  sig: string;
  nome: string;
  valor: unknown;
  venc: string;          // vencimento do boleto
  url: string;
  nAberto: number;       // boletos em aberto do mesmo cliente
  prazo?: string;        // prazo_final: data limite (dia útil)
  dataPrometida?: string; // promessa_quebrada
};

export function textosAtraso(c: CobrancaAtraso): string[] {
  const ola = saudacao(c.nome);
  const val = brMoney(c.valor);
  const url = c.url || '';
  const multi = c.nAberto > 1 ? ` Constam ${c.nAberto} boletos em aberto em seu nome.` : '';
  let b: string[];
  if (c.tipo === 'promessa_quebrada') {
    b = [
      `${ola} Você tinha combinado de pagar a parcela de R$ ${val} até ${ddmm(String(c.dataPrometida || ''))}, e o pagamento não entrou.`,
      `Aconteceu alguma coisa?`,
    ];
  } else if (c.tipo === 'prazo_final') {
    const primeiro = String(c.nome || '').trim().split(/\s+/)[0] || '';
    const prazo = String(c.prazo || '');
    b = [
      `${primeiro ? `Oi ${primeiro}.` : 'Oi.'} Sua parcela de R$ ${val} está vencida desde ${ddmm(c.venc)} e já tentei contato algumas vezes sem retorno.${multi}`,
      `Te dou até ${diaSemana(prazo)}, ${ddmm(prazo)}, pra pagar ou me chamar pra combinar: ${url}`,
      `Depois dessa data, o caso sai do atendimento por aqui e seguirá para o jurídico para as medidas de cobranças cabíveis.`,
    ];
  } else if (c.tipo === 'sete_dias') {
    b = [
      `${ola} Sua parcela de R$ ${val} está vencida desde ${ddmm(c.venc)} e segue em aberto.${multi}`,
      `Preciso que você regularize com urgência, pelo link:\n${url}`,
      `Se precisar combinar uma data, me responde aqui. Sem retorno, o caso segue para as próximas medidas de cobrança.`,
    ];
  } else {
    b = [
      `${ola} Sua parcela de R$ ${val} venceu em ${ddmm(c.venc)} e ainda não consta o pagamento.`,
      `Pedimos que regularize o quanto antes pra evitar o aumento de encargos e o prosseguimento da cobrança:\n${url}`,
      `Estou à disposição para conversar, caso precise.`,
    ];
  }
  b[0] = `${c.sig}\n${b[0]}`;
  return b;
}

// ===== Prazo final sai UMA vez =====
// Antes, o "prazo final" se repetia a cada 2 dias com uma data nova enquanto o
// caso não ia para ação — a data dada ao devedor deixava de valer. O prazo
// enviado fica no log ("PRAZO FINAL até AAAA-MM-DD: ..."); depois dele:
//  - dentro do prazo  -> não manda nada, volta a olhar no dia útil seguinte ao prazo
//  - prazo vencido    -> o caso vai para ação (é o que a mensagem anunciou)
export const PREFIXO_PRAZO = 'PRAZO FINAL até ';

export function prazoDoLog(texto: string | null | undefined): string | null {
  const m = String(texto || '').match(/^PRAZO FINAL até (\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

export function decidirPrazoFinal(prazoAnterior: string | null, hoje: string): 'enviar' | 'aguardar' | 'para_acao' {
  if (!prazoAnterior) return 'enviar';
  return hoje.slice(0, 10) <= prazoAnterior ? 'aguardar' : 'para_acao';
}
