// _shared/telefone-jid.ts — resolve o JID com que o WhatsApp realmente conhece
// um número brasileiro, ANTES de enviar.
//
// Por que existe: para DDD do Sul/Norte o WhatsApp costuma registrar o contato
// SEM o nono dígito (55 + DDD + 8), enquanto o cadastro (Asaas, planilha, CRM)
// guarda COM (55 + DDD + 9 + 8). Enviar para o formato errado NÃO dá erro: a
// Z-API aceita, devolve zaapId, gravamos "enviada" — e a mensagem fica num ✓
// para sempre, porque aquele JID não é o do devedor.
//
// Medido em produção em 09/09/2026, sobre crm_mensagens_status: dos 35 números
// discados com 13 dígitos, 24 conversavam conosco pelo formato de 12 (mesmo
// número, sem o 9) e apenas 1 era silêncio real. Taxa de resposta por formato
// discado: 12 dígitos 93% (267/288) x 13 dígitos 31% (11/35).
//
// A lógica de variantes já existia em enviar-whatsapp (a única rota que
// entregava direito). Aqui ela vira fonte única, para bia-cobranca e
// cron-mensagens-agendadas pararem de discar o número cru do cadastro.

export type ZapiHeaders = Record<string, string>;

export interface JidResolvido {
  /** JID a usar no campo `phone` da Z-API. null = nenhuma variante tem WhatsApp. */
  jid: string | null;
  /** Alguma variante tem WhatsApp ativo. */
  existe: boolean;
  /** Variantes consultadas, na ordem — para log/diagnóstico. */
  tentativas: string[];
  /** O JID difere do número normalizado de entrada. */
  mudou: boolean;
  /** A resolução veio do cache desta invocação. */
  doCache?: boolean;
  /**
   * Nenhuma consulta respondeu (rede/timeout/HTTP ruim): não se sabe se o número
   * existe. Diferente de `existe:false`, que é uma resposta real da Z-API. Quem
   * chama deve tratar como "sem informação" e NÃO marcar o devedor como sem
   * WhatsApp — senão uma instabilidade da Z-API pausaria cobranças válidas.
   */
  indeterminado?: boolean;
}

/**
 * Só os dígitos, com DDI 55 na frente quando o número vem em formato local.
 *
 * A regra é por COMPRIMENTO, nunca por `startsWith('55')`: o DDD 55 (região
 * central do RS) colide com o código do país, e um celular DDD 55 sem país
 * ('55999137675', 11 díg.) ficaria sem o 55 de país e seria roteado errado.
 */
export function comDDI55(telefone: unknown): string {
  const d = String(telefone ?? '').replace(/\D/g, '');
  if (!d) return '';
  return d.length === 10 || d.length === 11 ? '55' + d : d;
}

/** Grupo (`...-group`) e LID (16+ dígitos) não são telefone e não se canonizam. */
export function ehIdentificadorNaoTelefone(telefone: unknown): boolean {
  const bruto = String(telefone ?? '');
  if (bruto.includes('-group')) return true;
  const d = bruto.replace(/\D/g, '');
  return d.length > 13;
}

/** O próprio número e a variante com/sem o nono dígito, nessa ordem. */
export function variantesComEsem9(phone: string): string[] {
  const v = [phone];
  if (phone.length === 13) v.push(phone.slice(0, 4) + phone.slice(5));
  else if (phone.length === 12) v.push(phone.slice(0, 4) + '9' + phone.slice(4));
  return v;
}

// Cache por invocação da edge function: a régua manda vários blocos para o
// mesmo devedor e não faz sentido consultar o phone-exists a cada bloco.
const cache = new Map<string, JidResolvido>();

async function consultar(zBase: string, zHead: ZapiHeaders, variante: string): Promise<{ existe: boolean; canonico: string | null; falhou?: boolean }> {
  try {
    const r = await fetch(`${zBase}/phone-exists/${variante}`, { headers: zHead, signal: AbortSignal.timeout(7000) });
    if (!r.ok) return { existe: false, canonico: null, falhou: true };
    const j = await r.json().catch(() => null);
    if (!j) return { existe: false, canonico: null, falhou: true };
    const existe = typeof j.exists === 'boolean' ? j.exists : (typeof j.isUser === 'boolean' ? j.isUser : false);
    // A Z-API devolve em outputPhone o JID canônico do contato — quando vem, é
    // mais confiável que a variante que perguntamos.
    const canonico = existe ? (String(j.outputPhone || '').replace(/\D/g, '') || variante) : null;
    return { existe, canonico };
  } catch {
    return { existe: false, canonico: null, falhou: true };
  }
}

/**
 * Descobre o JID real do número. Consulta o phone-exists da Z-API para o número
 * e, se preciso, para a variante com/sem nono dígito.
 *
 * `dica` (opcional) é um formato já visto conversando conosco — normalmente o
 * telefone de crm_mensagens_recebidas. Quando bate com o número pelos 8 últimos
 * dígitos, entra como primeira variante e costuma poupar a chamada externa.
 *
 * Em falha de rede o retorno é `existe: false` com `jid` no número normalizado:
 * quem chama decide entre pular ou enviar assim mesmo (`jid` nunca é pior que o
 * comportamento antigo, que era discar o cru).
 */
export async function resolverJid(
  zBase: string,
  zHead: ZapiHeaders,
  telefone: unknown,
  dica?: string | null,
): Promise<JidResolvido> {
  const alvo = comDDI55(telefone);
  if (!alvo) return { jid: null, existe: false, tentativas: [], mudou: false };

  // Grupo/LID: já é o identificador final, não passa por phone-exists.
  if (ehIdentificadorNaoTelefone(telefone)) {
    return { jid: String(telefone), existe: true, tentativas: [], mudou: false };
  }

  const emCache = cache.get(alvo);
  if (emCache) return { ...emCache, doCache: true };

  const variantes = variantesComEsem9(alvo);
  const dicaLimpa = comDDI55(dica);
  if (dicaLimpa && dicaLimpa.slice(-8) === alvo.slice(-8) && !variantes.includes(dicaLimpa)) {
    variantes.unshift(dicaLimpa);
  } else if (dicaLimpa && variantes.includes(dicaLimpa)) {
    // a dica já é uma das variantes: tenta ela primeiro
    variantes.splice(variantes.indexOf(dicaLimpa), 1);
    variantes.unshift(dicaLimpa);
  }

  const tentativas: string[] = [];
  let todasFalharam = true;
  for (const v of variantes) {
    tentativas.push(v);
    const { existe, canonico, falhou } = await consultar(zBase, zHead, v);
    if (!falhou) todasFalharam = false;
    if (existe && canonico) {
      const r: JidResolvido = { jid: canonico, existe: true, tentativas, mudou: canonico !== alvo };
      cache.set(alvo, r);
      return r;
    }
  }

  // Instabilidade da Z-API não vira veredito sobre o número: devolve o formato
  // normalizado (o comportamento antigo) marcado como indeterminado, e NÃO
  // cacheia — a próxima tentativa consulta de novo.
  if (todasFalharam) return { jid: alvo, existe: false, indeterminado: true, tentativas, mudou: false };

  const r: JidResolvido = { jid: alvo, existe: false, tentativas, mudou: false };
  cache.set(alvo, r);
  return r;
}

/**
 * Mesmo assinante? Compara pelos últimos 8 dígitos, que não mudam entre os
 * formatos do mesmo número (com/sem nono dígito, com/sem DDI). Serve para
 * distinguir "outro formato do mesmo telefone" de "telefone trocado" — a
 * diferença entre preservar o JID que entrega e ficar preso num número velho.
 */
export function mesmoNumero(a: unknown, b: unknown): boolean {
  const sa = String(a ?? '').replace(/\D/g, '');
  const sb = String(b ?? '').replace(/\D/g, '');
  if (sa.length < 8 || sb.length < 8) return false;
  return sa.slice(-8) === sb.slice(-8);
}

/** Esvazia o cache — usado nos testes. */
export function _limparCacheJid(): void { cache.clear(); }
