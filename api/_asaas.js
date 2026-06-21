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

// Monta o endereço do Asaas a partir da row do devedor. A rua/logradouro vive no
// jsonb `endereco_crm` (a coluna `endereco` costuma ficar vazia); o resto em colunas
// próprias. Endereço completo é PRÉ-REQUISITO para emitir NFS-e no Asaas.
function buildAsaasAddress(dev) {
  const ec = (dev && dev.endereco_crm) || {};
  const a = {};
  const cep = String(dev.cep || ec.cep || '').replace(/\D/g, '');
  if (cep) a.postalCode = cep;
  const rua = String(ec.rua || ec.logradouro || dev.endereco || '').trim();
  if (rua) a.address = rua;
  const num = String(dev.numero || ec.numero || '').trim();
  if (num) a.addressNumber = num;
  const comp = String(dev.complemento || ec.complemento || '').trim();
  if (comp) a.complement = comp;
  const bairro = String(dev.bairro || ec.bairro || '').trim();
  if (bairro) a.province = bairro;
  return a;
}

// Garante o customer Asaas para uma row de devedor (Supabase), COM endereço completo
// (necessário p/ NFS-e). Retorna { customerId, created }. Não persiste o id — quem
// chama decide gravar asaas_customer_id; o endereço é gravado direto no Asaas.
async function ensureAsaasCustomer(dev) {
  const addr = buildAsaasAddress(dev);
  const hasAddr = Object.keys(addr).length > 0;
  // Customer já vinculado: garante o endereço nele (best-effort) p/ a NF não falhar.
  if (dev.asaas_customer_id) {
    if (hasAddr) { try { await asaasReq('PUT', `/customers/${dev.asaas_customer_id}`, addr); } catch (e) { /* best-effort */ } }
    return { customerId: dev.asaas_customer_id, created: false };
  }
  const doc = String(dev.doc || '').replace(/\D/g, '');
  if (!doc) throw new Error('Devedor sem CPF/CNPJ cadastrado.');
  const found = await asaasReq('GET', `/customers?cpfCnpj=${encodeURIComponent(doc)}`);
  if (found?.data?.length) {
    const id = found.data[0].id;
    if (hasAddr) { try { await asaasReq('PUT', `/customers/${id}`, addr); } catch (e) { /* best-effort */ } }
    return { customerId: id, created: false };
  }
  const created = await asaasReq('POST', '/customers', {
    name: dev.nome || 'Devedor',
    cpfCnpj: doc,
    email: dev.email || undefined,
    mobilePhone: dev.telefone ? String(dev.telefone).replace(/\D/g, '') : undefined,
    ...addr,
    notificationDisabled: true,
  });
  return { customerId: created.id, created: true };
}

module.exports = { asaasReq, ensureAsaasCustomer, ASAAS_ENV };
