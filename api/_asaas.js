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

// Garante o customer Asaas para uma row de devedor (Supabase). Retorna
// { customerId, created }. Não persiste — quem chama decide gravar asaas_customer_id.
async function ensureAsaasCustomer(dev) {
  if (dev.asaas_customer_id) return { customerId: dev.asaas_customer_id, created: false };
  const doc = String(dev.doc || '').replace(/\D/g, '');
  if (!doc) throw new Error('Devedor sem CPF/CNPJ cadastrado.');
  const found = await asaasReq('GET', `/customers?cpfCnpj=${encodeURIComponent(doc)}`);
  if (found?.data?.length) return { customerId: found.data[0].id, created: false };
  const created = await asaasReq('POST', '/customers', {
    name: dev.nome || 'Devedor',
    cpfCnpj: doc,
    email: dev.email || undefined,
    mobilePhone: dev.telefone ? String(dev.telefone).replace(/\D/g, '') : undefined,
    notificationDisabled: true,
  });
  return { customerId: created.id, created: true };
}

module.exports = { asaasReq, ensureAsaasCustomer, ASAAS_ENV };
