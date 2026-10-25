// Fila do WhatsApp: mensagem a devedor não sai em sábado, domingo ou feriado.
//
// 25/10/2026 — o aviso de cumprimento de sentença ao Sidimar foi posto na fila à
// 00:51 de sábado como "amanhã 9h" e saiu às 09:00 de domingo. Regra do Gustavo:
// o que foi AGENDADO antes para cair em dia não útil fica para o próximo dia útil,
// às 09:00; o que alguém põe na fila no próprio dia (resposta escrita na hora a
// quem escreveu no fim de semana) sai. Avisos internos e grupos de credor ficam
// fora da trava (quem chama decide).
import { diaUtilEmOuDepois, ehDiaUtil } from './dias-uteis.ts';

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
