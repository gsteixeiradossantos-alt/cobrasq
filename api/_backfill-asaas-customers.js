// api/_backfill-asaas-customers.js — Vincula asaas_customer_id em TODOS os devedores,
// casando por CPF/CNPJ contra a lista de clientes do Asaas. Despachado por
// api/automacao.js (?action=backfill-asaas-customers). Owner-only. Idempotente.
//
// Por que existe: o webhook de pagamento (asaas-webhook) só casa o pagador por
// devedores.asaas_customer_id. Sem ele, o pagamento de um devedor não vira
// fin_operacao. A emissão nativa já grava esse id, mas devedores antigos / cobranças
// criadas fora (n8n, cobrança direta) ficaram sem vínculo. Este backfill liga todos.
//
// Teste sem gravar: GET /api/backfill-asaas-customers?dry=1

const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');
const { asaasReq } = require('./_asaas.js');

const digits = (s) => String(s || '').replace(/\D/g, '');

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireUser(req, res);
  if (!user) return;
  // Gate de proprietário (service role ignora RLS).
  let papel = null;
  try {
    const rows = await sbFetch(`app_users?id=eq.${encodeURIComponent(user.id)}&select=papel`);
    papel = Array.isArray(rows) && rows[0] ? rows[0].papel : null;
  } catch (e) {
    return res.status(500).json({ error: 'Não foi possível verificar permissão.' });
  }
  if (papel !== 'proprietario') {
    return res.status(403).json({ error: 'Apenas o proprietário pode rodar o backfill.' });
  }

  const dry = req.query?.dry === '1' || req.query?.dry === 'true';

  try {
    // 1. Todos os clientes do Asaas (paginado) → doc (só dígitos) → set de customer ids.
    const byDoc = new Map();
    let offset = 0; const limit = 100; let totalAsaas = 0;
    for (;;) {
      const r = await asaasReq('GET', `/customers?offset=${offset}&limit=${limit}`);
      const list = Array.isArray(r && r.data) ? r.data : [];
      for (const c of list) {
        const d = digits(c.cpfCnpj);
        if (!d || !c.id) continue;
        if (!byDoc.has(d)) byDoc.set(d, new Set());
        byDoc.get(d).add(c.id);
      }
      totalAsaas += list.length;
      if (!r || !r.hasMore || list.length < limit) break;
      offset += limit;
      if (offset > 200000) break; // backstop
    }

    // 2. Devedores (id, doc, vínculo atual). doc_digits é a coluna de dígitos já
    //    normalizada (mesma usada pelo importar-asaas); cai p/ doc se faltar.
    const devs = (await sbFetch(`devedores?select=id,nome,doc,doc_digits,asaas_customer_id`)) || [];

    // 3. Casa por doc; só atualiza onde há EXATAMENTE 1 cliente e ainda não está certo.
    const updates = [];
    let already = 0, ambiguous = 0, unmatched = 0, semDoc = 0;
    const ambiguousList = [];
    for (const dv of devs) {
      const d = digits(dv.doc_digits || dv.doc);
      if (!d) { semDoc++; continue; }
      const set = byDoc.get(d);
      if (!set || set.size === 0) { unmatched++; continue; }
      if (set.size > 1) { ambiguous++; if (ambiguousList.length < 15) ambiguousList.push({ nome: dv.nome, doc: d }); continue; }
      const cust = [...set][0];
      if (dv.asaas_customer_id === cust) { already++; continue; }
      updates.push({ id: dv.id, cust });
    }

    if (!dry) {
      for (const u of updates) {
        await sbFetch(`devedores?id=eq.${u.id}`, {
          method: 'PATCH', body: JSON.stringify({ asaas_customer_id: u.cust }),
        }).catch((e) => console.warn('[backfill-asaas] patch', u.id, e && e.message));
      }
    }

    return res.status(200).json({
      ok: true,
      dry,
      asaas_clientes: totalAsaas,
      devedores: devs.length,
      vinculados: updates.length,
      ja_ok: already,
      ambiguos: ambiguous,
      sem_match: unmatched,
      sem_doc: semDoc,
      ambiguos_amostra: ambiguousList,
    });
  } catch (e) {
    console.error('[backfill-asaas-customers]', e && e.message);
    return res.status(500).json({ error: e && e.message });
  }
};
