// Modos de operação da Bia no atendimento (whatsapp_bia_config).
//
// "Só Carlos" + "só boleto" ligados juntos = o Carlos negocia os casos com o
// botão "Ativar Carlos" e a Bia responde SOMENTE pedido de boleto/2ª via
// (busca no Asaas e manda o link). Tudo o mais fica sem resposta automática,
// para a equipe, em Pendentes — inclusive contato com cobrança ativa,
// "já paguei", comprovante e áudio não transcrito. Decisão do Gustavo em
// 27/10/2026 ("Bia só para boleto").
//
// Só "só boleto" (sem "só Carlos") mantém o comportamento antigo: boleto e
// alguns assuntos fixos, e o playbook completo para quem tem cobrança ativa.

export const ACOES_MODO_BOLETO_ANTIGO = ['enviar_boleto', 'ja_paguei', 'quer_comprovante', 'credor_info', 'lead_comercial'];

export function modoSoBoleto(cfg: any): boolean {
  return cfg?.somente_carlos === true && cfg?.modo_boleto_only === true;
}

// A Bia fica de fora da conversa (o Carlos não está nela)?
export function biaDesligadaSoCarlos(cfg: any): boolean {
  return cfg?.somente_carlos === true && cfg?.modo_boleto_only !== true;
}

// Depois que a IA classificou a mensagem: a Bia NÃO deve agir nesta ação?
export function pularAcaoBia(cfg: any, cobAtiva: boolean, acao: string): boolean {
  if (modoSoBoleto(cfg)) return acao !== 'enviar_boleto';
  if (cfg?.modo_boleto_only === true && !cobAtiva) return !ACOES_MODO_BOLETO_ANTIGO.includes(acao);
  return false;
}

// Arquivo (comprovante) ou áudio que não deu para transcrever: a Bia fica quieta?
export function pularMidiaBia(cfg: any, cobAtiva: boolean): boolean {
  if (modoSoBoleto(cfg)) return true;
  return cfg?.modo_boleto_only === true && !cobAtiva;
}
