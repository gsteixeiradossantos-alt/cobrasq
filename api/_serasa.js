// api/_serasa.js — Negativação em bureau (Serasa Experian, API V2 REST/JSON).
//
// ⚠️ A ESTRUTURA está pronta, mas o CONTRATO REAL da API do Serasa (URLs exatas,
// formato do payload, fluxo de auth, código de "natureza da dívida") só se confirma
// com a DOCUMENTAÇÃO do credenciamento. Por isso o bloco de requisição está marcado
// "ADAPTAR AO CONTRATO REAL" e as URLs são sobrescrevíveis por env — dá pra ajustar
// sem mexer no código. Tudo é GATED: sem credencial, retorna { pendente }.
//
// Envs (definir na Vercel; o cron só executa com SERASA_LIVE=1):
//   SERASA_API_KEY            — token direto, se o contrato usar API key
//   SERASA_CLIENT_ID/SECRET   — se o contrato usar OAuth2 client_credentials
//   SERASA_BASE_URL           — base da API (ADAPTAR: default é palpite)
//   SERASA_TOKEN_URL          — endpoint de login OAuth2 (se for o caso)
//   SERASA_CREDOR_CNPJ        — CNPJ do credor (COBRASQ) informado na inclusão
//
// LEGAL: o bureau envia o aviso prévio (~10 dias, Súmula 359 STJ) → cadastro/endereço
// corretos; após o pagamento, EXCLUIR em até 5 dias úteis (o cron chama excluir).

const BASE = (process.env.SERASA_BASE_URL || 'https://api.serasaexperian.com.br').replace(/\/+$/, '');

function onlyDigits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

function _serasaConfigurado() {
  return !!(process.env.SERASA_API_KEY || (process.env.SERASA_CLIENT_ID && process.env.SERASA_CLIENT_SECRET));
}

// Auth: devolve o header Authorization. ADAPTAR conforme o contrato (API key vs OAuth2).
async function _serasaAuthHeader() {
  const key = process.env.SERASA_API_KEY;
  if (key) return { 'Authorization': `Bearer ${key}` }; // ADAPTAR: alguns contratos usam header próprio (ex.: X-Api-Key)
  const id = process.env.SERASA_CLIENT_ID, secret = process.env.SERASA_CLIENT_SECRET;
  if (id && secret) {
    const tokenUrl = process.env.SERASA_TOKEN_URL || `${BASE}/security/iam/v1/client-identities/login`;
    const r = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64') },
      body: 'grant_type=client_credentials',
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error('Falha no login OAuth2 do Serasa.');
    return { 'Authorization': `Bearer ${j.access_token}` };
  }
  throw new Error('Credenciais Serasa ausentes.');
}

// Inclui a dívida no bureau. Retorno: { ok:true, transactionId } | { ok:false, erro } | { pendente }.
async function incluirNegativacao(dados) {
  if (!_serasaConfigurado()) return { ok: false, pendente: 'credenciais', msg: 'Credenciais Serasa ausentes (SERASA_API_KEY ou CLIENT_ID/SECRET).' };
  try {
    const headers = { 'Content-Type': 'application/json', ...(await _serasaAuthHeader()) };
    // ═══ ADAPTAR AO CONTRATO REAL (endpoint + shape do payload, doc do credenciamento) ═══
    const url = `${BASE}/credit-services/negative-records/v1/inclusions`;
    const body = {
      creditor: { document: onlyDigits(process.env.SERASA_CREDOR_CNPJ || dados.credorCnpj) },
      debtor: {
        document: onlyDigits(dados.devedorDoc),
        name: dados.devedorNome || '',
        address: dados.endereco || undefined, // cadastro correto = pré-requisito do aviso prévio
      },
      debt: {
        contract: String(dados.contrato || dados.cobrancaId || ''),
        amount: Number(dados.valor || 0).toFixed(2),
        dueDate: dados.vencimento || null,     // 'YYYY-MM-DD'
        nature: dados.natureza || '97',        // ADAPTAR: código da natureza da dívida
      },
    };
    // ════════════════════════════════════════════════════════════════════════════════
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, erro: j?.message || j?.error || `Serasa HTTP ${r.status}`, detalhe: j };
    return { ok: true, transactionId: j.transactionId || j.protocol || j.id || null, raw: j };
  } catch (e) {
    return { ok: false, erro: String(e?.message || e) };
  }
}

// Exclui a negativação (baixa após pagamento).
async function excluirNegativacao(dados) {
  if (!_serasaConfigurado()) return { ok: false, pendente: 'credenciais' };
  try {
    const headers = { 'Content-Type': 'application/json', ...(await _serasaAuthHeader()) };
    // ═══ ADAPTAR AO CONTRATO REAL ═══
    const url = `${BASE}/credit-services/negative-records/v1/exclusions`;
    const body = {
      creditor: { document: onlyDigits(process.env.SERASA_CREDOR_CNPJ || dados.credorCnpj) },
      debtor: { document: onlyDigits(dados.devedorDoc) },
      transactionId: dados.transactionId || undefined,
    };
    // ════════════════════════════════
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, erro: j?.message || `Serasa HTTP ${r.status}`, detalhe: j };
    return { ok: true, raw: j };
  } catch (e) {
    return { ok: false, erro: String(e?.message || e) };
  }
}

module.exports = { incluirNegativacao, excluirNegativacao, _serasaConfigurado };
