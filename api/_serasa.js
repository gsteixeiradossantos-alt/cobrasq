// api/_serasa.js — Negativação em bureau de crédito (Serasa/SPC/Boa Vista).
// ⛔ STUB da Onda 4 (QuitaFácil). O wiring REAL depende de contrato + credenciais
// (envs SERASA_*). Enquanto ausentes, as funções retornam { ok:false, pendente }
// SEM tocar em nenhum bureau — o resto do fluxo (fila de aprovação, marca de
// candidato) funciona normalmente e só a inclusão/exclusão de fato fica em espera.
//
// Regras que a Parte B DEVE respeitar ao ligar a API:
//  - Só negativar dívida certa, líquida, vencida, com cessão documentada (credor = CNPJ COBRASQ).
//  - O bureau envia o aviso prévio (~10 dias, Súmula 359 STJ) — cadastro/endereço têm de estar corretos.
//  - Após pagamento, EXCLUIR em até 5 dias úteis (senão dano moral). Ver asaas-webhook.
//  - API Serasa V2 (REST/JSON); a V1 SOAP é descontinuada em 30/06/2026.

function _serasaConfigurado() {
  return !!(process.env.SERASA_API_KEY || process.env.SERASA_TOKEN);
}

// Inclui a dívida no bureau. Retorno esperado (Parte B): { ok:true, transactionId }.
async function incluirNegativacao(dados) {
  if (!_serasaConfigurado()) {
    return { ok: false, pendente: 'credenciais', msg: 'Contrato/credenciais do bureau ausentes (SERASA_API_KEY).' };
  }
  // TODO (Parte B): POST na API V2 de inclusão (assíncrona → transactionID).
  // dados esperados: { credorCnpj, devedorDoc, devedorNome, valor, vencimento, contrato }
  return { ok: false, pendente: 'implementacao', msg: 'Inclusão no bureau ainda não implementada (Parte B).' };
}

// Exclui a negativação (baixa) após pagamento.
async function excluirNegativacao(dados) {
  if (!_serasaConfigurado()) {
    return { ok: false, pendente: 'credenciais' };
  }
  // TODO (Parte B): POST/DELETE na API de exclusão. dados: { transactionId, devedorDoc, credorCnpj }
  return { ok: false, pendente: 'implementacao' };
}

module.exports = { incluirNegativacao, excluirNegativacao, _serasaConfigurado };
