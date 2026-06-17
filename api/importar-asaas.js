// api/importar-asaas.js — Lista clientes do Asaas que NÃO têm cadastro local (match
// por CPF/CNPJ contra devedores.doc_digits), já com CPF/telefone/endereço pré-
// preenchidos. (PR8 — aba "Importação".) O usuário só acrescenta o nome e salva pelo
// fluxo normal de devedor (que já grava asaas_customer_id — PR1). Decisão do usuário:
// SÓ listar os sem cadastro; não religar existentes em massa.
//
// Auth: usuário Supabase logado (feature do app). Paginação via ?offset=&limit=.

const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');
const { asaasReq } = require('./_asaas.js');

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireUser(req, res);
  if (!user) return;

  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 100));

  try {
    const customers = await asaasReq('GET', `/customers?offset=${offset}&limit=${limit}`);
    const list = Array.isArray(customers.data) ? customers.data : [];

    // Cruza por CPF/CNPJ (só dígitos) com os devedores já cadastrados.
    const docs = [...new Set(list.map(c => String(c.cpfCnpj || '').replace(/\D/g, '')).filter(Boolean))];
    const existentes = new Set();
    if (docs.length) {
      const inList = docs.map(encodeURIComponent).join(',');
      const devs = await sbFetch(`devedores?select=doc_digits&doc_digits=in.(${inList})`).catch(() => []);
      for (const d of devs) if (d.doc_digits) existentes.add(d.doc_digits);
    }

    const novos = list
      .filter(c => {
        const dg = String(c.cpfCnpj || '').replace(/\D/g, '');
        return dg && !existentes.has(dg);
      })
      .map(c => ({
        asaas_customer_id: c.id,
        nome: c.name || '',
        cpf: c.cpfCnpj || '',
        telefone: c.mobilePhone || c.phone || '',
        email: c.email || '',
        endereco: [c.address, c.addressNumber, c.province, c.city, c.state].filter(Boolean).join(', '),
        cep: c.postalCode || '',
      }));

    return res.status(200).json({
      ok: true,
      offset, limit,
      total: customers.totalCount ?? null,
      hasMore: !!customers.hasMore,
      pagina: list.length,
      sem_cadastro: novos.length,
      novos,
    });
  } catch (e) {
    console.error('[importar-asaas]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
