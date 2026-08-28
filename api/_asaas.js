// api/_asaas.js — Cliente Asaas server-side compartilhado pelos endpoints Vercel
// (emissão de boletos, repasse PIX, NFS-e). Usa ASAAS_API_KEY do ambiente — a chave
// NUNCA vem do browser (ver api/asaas.js). ASAAS_ENV = sandbox|production.

const ASAAS_KEY = process.env.ASAAS_API_KEY || '';
const ASAAS_ENV = process.env.ASAAS_ENV || 'sandbox';
const BASE = ASAAS_ENV === 'production'
  ? 'https://www.asaas.com/api/v3'
  : 'https://sandbox.asaas.com/api/v3';

async function asaasReq(method, path, data) {
  if (!ASAAS_KEY) throw new Error('ASAAS_API_KEY não configurada no servidor.');
  const opts = {
    method,
    headers: {
      access_token: ASAAS_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'COBRASQ-Server/1.0',
    },
  };
  if (data && !['GET', 'DELETE', 'HEAD'].includes(method)) opts.body = JSON.stringify(data);
  const r = await fetch(`${BASE}/${String(path).replace(/^\/+/, '')}`, opts);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) throw new Error(json?.errors?.[0]?.description || json?.message || `Asaas ${r.status}`);
  return json;
}

// Primeiro valor não-vazio da lista, já aparado.
function primeiro(...vs) {
  for (const v of vs) { const t = String(v == null ? '' : v).trim(); if (t) return t; }
  return '';
}

// Telefone no formato que o Asaas aceita: DDD + número, só dígitos, SEM o 55.
// Trata as três sujeiras do cadastro: número com DDI ('5546999824142'), zero à
// esquerda e campo com VÁRIOS telefones ('42984332184, 42991515679') — nesse caso
// vale o primeiro que for um número brasileiro plausível.
function telAsaas(v) {
  const bruto = String(v == null ? '' : v);
  const candidatos = bruto.split(/[^0-9]+/).filter(Boolean);
  const inteiro = bruto.replace(/\D/g, '');
  for (const c of [...candidatos, inteiro]) {
    let d = c.replace(/^0+/, '');
    if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
    if (d.length === 10 || d.length === 11) return d;
  }
  return '';
}

// Monta o endereço do Asaas a partir da row do devedor. Endereço completo é
// PRÉ-REQUISITO para emitir NFS-e no Asaas, e ele vive em TRÊS lugares diferentes,
// conforme por onde o cadastro entrou:
//   • `endereco_crm` (jsonb) — importação e NF avulsa escrevem aqui;
//   • colunas próprias (cep, rua, numero, …) — cadastro relacional;
//   • `metadata` (jsonb) — é onde CAI o endereço digitado no painel: devedorToRow
//     não mapeia esses campos para colunas, então tudo vai para o metadata.
// Ler só as duas primeiras (comportamento anterior) mandava endereço VAZIO para o
// Asaas justamente no caso mais comum, o do endereço digitado na ficha. A coluna
// `rua` também era ignorada, apesar de existir.
function buildAsaasAddress(dev) {
  const d = dev || {};
  const ec = d.endereco_crm || {};
  const md = d.metadata || {};
  const mdEc = md.enderecoCrm || md.endereco_crm || {};   // blob antigo, em camelCase
  const a = {};
  const cep = primeiro(d.cep, ec.cep, md.cep, mdEc.cep).replace(/\D/g, '');
  if (cep) a.postalCode = cep;
  const rua = primeiro(ec.rua, ec.logradouro, d.rua, md.rua, md.logradouro, mdEc.rua, mdEc.logradouro, d.endereco);
  if (rua) a.address = rua;
  const num = primeiro(d.numero, ec.numero, md.numero, mdEc.numero);
  if (num) a.addressNumber = num;
  const comp = primeiro(d.complemento, ec.complemento, md.complemento, mdEc.complemento);
  if (comp) a.complement = comp;
  const bairro = primeiro(d.bairro, ec.bairro, md.bairro, mdEc.bairro);
  if (bairro) a.province = bairro;
  return a;
}

// Campos de CONTATO que faltam no customer do Asaas e que temos no cadastro.
// Só preenche buraco: telefone/e-mail já cadastrados no Asaas não são sobrescritos
// (lá pode ter sido corrigido por atendimento, e o nosso cadastro é o lado sujo).
function contatoFaltante(atual, dev) {
  const out = {};
  const c = atual || {};
  const tel = telAsaas(dev && dev.telefone);
  if (tel && !telAsaas(c.mobilePhone) && !telAsaas(c.phone)) out.mobilePhone = tel;
  const email = primeiro(dev && dev.email).toLowerCase();
  if (email && /.+@.+\..+/.test(email) && !primeiro(c.email)) out.email = email;
  return out;
}

// Garante o customer Asaas para uma row de devedor (Supabase), COM endereço completo
// (necessário p/ NFS-e). Retorna { customerId, created }. Não persiste o id — quem
// chama decide gravar asaas_customer_id; o endereço é gravado direto no Asaas.
// Sincroniza endereço + contato faltante num customer que JÁ existe. Best-effort:
// falha aqui não derruba a emissão. Antes daqui, telefone e e-mail só entravam na
// CRIAÇÃO do customer — quem já tinha customer no Asaas nunca recebia o telefone
// descoberto depois (assinatura no ZapSign, ligação, atualização de ficha).
async function sincronizarCustomer(id, dev, addr, atualConhecido) {
  try {
    let atual = atualConhecido;
    if (!atual) {
      try { atual = await asaasReq('GET', `/customers/${id}`); } catch (e) { atual = null; }
    }
    // Sem conseguir ler o customer, mandamos só o endereço — não dá para saber se o
    // telefone de lá está preenchido, e sobrescrever seria pior do que não mexer.
    const contato = atual ? contatoFaltante(atual, dev) : {};
    const payload = { ...addr, ...contato };
    if (!Object.keys(payload).length) return { atualizado: false, campos: [] };
    await asaasReq('PUT', `/customers/${id}`, payload);
    return { atualizado: true, campos: Object.keys(payload) };
  } catch (e) {
    return { atualizado: false, campos: [], erro: e && e.message };
  }
}

async function ensureAsaasCustomer(dev) {
  const addr = buildAsaasAddress(dev);
  // Customer já vinculado: garante endereço e contato nele (best-effort) p/ a NF não falhar.
  if (dev.asaas_customer_id) {
    const sync = await sincronizarCustomer(dev.asaas_customer_id, dev, addr, null);
    return { customerId: dev.asaas_customer_id, created: false, sync };
  }
  const doc = String(dev.doc || '').replace(/\D/g, '');
  if (!doc) throw new Error('Devedor sem CPF/CNPJ cadastrado.');
  const found = await asaasReq('GET', `/customers?cpfCnpj=${encodeURIComponent(doc)}`);
  if (found?.data?.length) {
    const atual = found.data[0];
    const sync = await sincronizarCustomer(atual.id, dev, addr, atual);
    return { customerId: atual.id, created: false, sync };
  }
  const created = await asaasReq('POST', '/customers', {
    name: dev.nome || 'Devedor',
    cpfCnpj: doc,
    email: primeiro(dev.email).toLowerCase() || undefined,
    mobilePhone: telAsaas(dev.telefone) || undefined,
    ...addr,
    notificationDisabled: true,
  });
  return { customerId: created.id, created: true };
}

module.exports = { asaasReq, ensureAsaasCustomer, buildAsaasAddress, contatoFaltante, telAsaas, ASAAS_ENV };
