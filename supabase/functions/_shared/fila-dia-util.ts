// Fila do WhatsApp: mensagem a devedor não sai em sábado, domingo ou feriado.
//
// 25/10/2026 — o aviso de cumprimento de sentença ao Sidimar foi posto na fila à
// 00:51 de sábado como "amanhã 9h" e saiu às 09:00 de domingo. Regra do Gustavo:
// o que foi AGENDADO antes para cair em dia não útil fica para o próximo dia útil,
// às 09:00; o que alguém põe na fila no próprio dia (resposta escrita na hora a
// quem escreveu no fim de semana) sai. Avisos internos e grupos de credor ficam
// fora da trava (quem chama decide).
//
// 27/10/2026 — mesma lógica para o horário: o que foi agendado antes para sair
// fora das 08h às 20h (Brasília) fica para as 09h do próximo dia útil; o que
// alguém acabou de pôr na fila (até 15 min) sai na hora.
import { diaUtilEmOuDepois, ehDiaUtil, somarDias } from './dias-uteis.ts';

// Data do calendário em Brasília ('YYYY-MM-DD').
export function dataBrasilia(iso: string | Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(iso));
}

// Novo agendada_para (ISO) quando a mensagem tem de esperar o dia útil; null se pode sair.
export function adiarParaDiaUtil(agora: string | Date, criadaEm: string | Date | null): string | null {
  const hoje = dataBrasilia(agora);
  if (ehDiaUtil(hoje)) return null;
  if (criadaEm && dataBrasilia(criadaEm) === hoje) return null;
  return new Date(`${diaUtilEmOuDepois(hoje)}T09:00:00-03:00`).toISOString();
}

// Janela de envio a devedor: 08:00 a 19:59 em Brasília.
const HORA_INICIO = 8;
const HORA_FIM = 20;
// Posta na fila há até isto = mandada na hora por alguém, não agendada antes.
const NA_HORA_MS = 15 * 60_000;

function horaBrasilia(iso: string | Date): number {
  const h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }).format(new Date(iso)), 10);
  return h === 24 ? 0 : h;
}

// Novo agendada_para (ISO) quando a mensagem tem de esperar o horário; null se pode sair.
export function adiarParaHorario(agora: string | Date, criadaEm: string | Date | null): string | null {
  const h = horaBrasilia(agora);
  if (h >= HORA_INICIO && h < HORA_FIM) return null;
  if (criadaEm && new Date(agora).getTime() - new Date(criadaEm).getTime() <= NA_HORA_MS) return null;
  const hoje = dataBrasilia(agora);
  const dia = h < HORA_INICIO ? diaUtilEmOuDepois(hoje) : diaUtilEmOuDepois(somarDias(hoje, 1));
  return new Date(`${dia}T09:00:00-03:00`).toISOString();
}
