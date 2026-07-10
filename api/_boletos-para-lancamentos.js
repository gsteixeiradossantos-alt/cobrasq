// api/_boletos-para-lancamentos.js — Cadastra os boletos ATIVOS do Asaas
// (status PENDING + OVERDUE, TODOS os tipos) como lançamentos de RECEITA/PENDENTE
// na conta Asaas, categoria "Acordos". Regra do usuário: mesmo customer com mais de
// um boleto = PARCELAMENTO (parcelas 1..N por vencimento). Vincula ao contato por
// CPF/CNPJ (devedores.asaas_customer_id → doc_digits → fin_contato.documento). Sem
// match no sistema (cus_) fica SEM contato e é processado por ÚLTIMO.
//
// Idempotente: cada lançamento leva uuid = 'asaas:<payment_id>'; re-execuções pulam
// os que já existem. Modos (?modo=): 'dry' (prévia, não grava) | 'um' (grava só o 1º
// pendente) | 'todos' (grava todos os pendentes). Guarda o boleto em raw_payload.
//
// Auth: proprietário logado. Despachado por automacao.js (?action=boletos-para-lancamentos).
// A chave do Asaas e a service role do Supabase ficam SÓ no servidor (env).

const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');
const { asaasReq } = require('./_asaas.js');

const CONTA_ASAAS = 13;
const CATEGORIA_ACORDOS = 167;

const digits = (s) => String(s || '').replace(/\D/g, '');

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireUser(req, res);
  if (!user) return;

  // Gate de proprietário (service role ignora RLS, então checamos aqui).
  let papel = null;
  try {
    const rows = await sbFetch(`app_users?id=eq.${encodeURIComponent(user.id)}&select=papel`);
    papel = Array.isArray(rows) && rows[0] ? rows[0].papel : null;
  } catch (_e) {
    return res.status(500).json({ error: 'Não foi possível verificar permissão.' });
  }
  if (papel !== 'proprietario') {
    return res.status(403).json({ error: 'Apenas o proprietário pode importar boletos.' });
  }

  const modo = ['dry', 'um', 'todos'].includes(String(req.query.modo)) ? String(req.query.modo) : 'dry';

  try {
    // 1) Boletos ativos: PENDING + OVERDUE, todos os tipos, paginado.
    const charges = [];
    for (const st of ['PENDING', 'OVERDUE']) {
      let offset = 0;
      for (let guard = 0; guard < 100; guard++) {
        const d = await asaasReq('GET', `/payments?status=${st}&limit=100&offset=${offset}`);
        const arr = Array.isArray(d.data) ? d.data : [];
        charges.push(...arr);
        if (!d.hasMore) break;
        offset += 100;
      }
    }

    // 2) customer -> devedor (nome, doc_digits) via devedores.asaas_customer_id.
    const custIds = [...new Set(charges.map(c => c.customer).filter(Boolean))];
    const devByCust = {};
    for (let i = 0; i < custIds.length; i += 50) {
      const chunk = custIds.slice(i, i + 50).map(encodeURIComponent).join(',');
      const devs = await sbFetch(`devedores?select=asaas_customer_id,nome,doc_digits&asaas_customer_id=in.(${chunk})`).catch(() => []);
      for (const d of devs) if (d.asaas_customer_id) devByCust[d.asaas_customer_id] = d;
    }

    // 3) doc_digits -> fin_contato.id (fin_contato tem ~poucas linhas; busca tudo e casa em JS).
    const contatoByDoc = {};
    try {
      const contatos = await sbFetch(`fin_contato?select=id,documento&limit=5000`);
      for (const c of (contatos || [])) { const dd = digits(c.documento); if (dd) contatoByDoc[dd] = c.id; }
    } catch (_) { /* segue sem vínculo */ }

    // 4) Agrupa por customer (regra do usuário: >1 boleto = parcelamento), ordena por vencimento.
    const byCust = {};
    for (const p of charges) { const k = p.customer || '(sem-customer)'; (byCust[k] = byCust[k] || []).push(p); }

    // 5) Idempotência: uuids já existentes p/ os payment ids deste lote.
    const uuids = charges.map(p => 'asaas:' + p.id);
    const existentes = new Set();
    for (let i = 0; i < uuids.length; i += 80) {
      const chunk = uuids.slice(i, i + 80).map(encodeURIComponent).join(',');
      const ex = await sbFetch(`fin_lancamento?select=uuid&uuid=in.(${chunk})`).catch(() => []);
      for (const r of ex) if (r.uuid) existentes.add(r.uuid);
    }

    // 6) Monta o plano. Matched (com devedor) primeiro; cus_ (sem cadastro) por último.
    const plano = [];
    for (const [cust, listRaw] of Object.entries(byCust)) {
      const list = listRaw.slice().sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')));
      const dev = devByCust[cust] || null;
      const total = list.length;
      list.forEach((p, idx) => {
        const nome = dev && dev.nome ? dev.nome : (p.description || ('Cliente Asaas ' + cust));
        const parcela = total > 1 ? (idx + 1) : null;
        const desc = nome + (parcela ? ` · ${parcela}/${total}` : '');
        const contato_id = dev ? (contatoByDoc[digits(dev.doc_digits)] || null) : null;
        plano.push({
          payment_id: p.id,
          uuid: 'asaas:' + p.id,
          ja_existe: existentes.has('asaas:' + p.id),
          matched: !!dev,
          descricao: desc,
          valor: p.value,
          data_vencimento: p.dueDate || null,
          data_competencia: p.dueDate || null,
          numero_parcela: parcela,
          total_parcelas: total > 1 ? total : null,
          conta_id: CONTA_ASAAS,
          contato_id,
          billingType: p.billingType,
          status_asaas: p.status,
          customer: cust,
          _raw: p,
        });
      });
    }
    // Ordena: com contato/devedor primeiro; sem cadastro (cus_) por último. Depois por vencimento.
    plano.sort((a, b) => (Number(b.matched) - Number(a.matched)) || String(a.data_vencimento || '').localeCompare(String(b.data_vencimento || '')));

    const pendentes = plano.filter(x => !x.ja_existe);
    const resumo = {
      total_boletos: plano.length,
      ja_cadastrados: plano.length - pendentes.length,
      a_criar: pendentes.length,
      com_contato: pendentes.filter(x => x.contato_id).length,
      sem_cadastro_cus: pendentes.filter(x => !x.matched).length,
      parcelamentos: Object.values(byCust).filter(l => l.length > 1).length,
      conta_id: CONTA_ASAAS, categoria_id: CATEGORIA_ACORDOS,
    };

    // 7) Grava conforme o modo.
    let aInserir = [];
    if (modo === 'um') aInserir = pendentes.slice(0, 1);
    else if (modo === 'todos') aInserir = pendentes;
    // modo 'dry' → aInserir vazio.

    let criados = [];
    if (aInserir.length) {
      // Insert em LOTE (1 request) p/ não estourar o timeout do Vercel com muitos boletos.
      const payload = aInserir.map(it => ({
        descricao: it.descricao,
        valor: it.valor,
        tipo_movimento: 1,           // receita
        status: 0,                   // pendente
        conta_id: it.conta_id,
        contato_id: it.contato_id,
        data_vencimento: it.data_vencimento,
        data_competencia: it.data_competencia,
        numero_parcela: it.numero_parcela,
        total_parcelas: it.total_parcelas,
        uuid: it.uuid,
        raw_payload: { source: 'asaas-boletos', asaas_payment_id: it.payment_id, customer: it.customer, billingType: it.billingType, status: it.status_asaas },
      }));
      const inserted = await sbFetch('fin_lancamento', { method: 'POST', body: JSON.stringify(payload), prefer: 'return=representation' });
      const rows = Array.isArray(inserted) ? inserted : [inserted];
      // categoria "Acordos" na join (sem rateio: valor = valor do lançamento) — em lote.
      const cats = rows.map((row, i) => ({ lancamento_id: row.id, categoria_id: CATEGORIA_ACORDOS, valor: aInserir[i].valor }));
      try { if (cats.length) await sbFetch('fin_lancamento_categoria', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(cats) }); } catch (_e) { /* categoria é secundária; não aborta */ }
      criados = rows.map((row, i) => ({ id: row.id, descricao: aInserir[i].descricao, valor: aInserir[i].valor, vencimento: aInserir[i].data_vencimento, contato_id: aInserir[i].contato_id, parcela: aInserir[i].numero_parcela, total: aInserir[i].total_parcelas }));
    }

    return res.status(200).json({
      ok: true, modo, resumo,
      criados,
      // No dry, devolve uma amostra do que criaria (primeiros 8) p/ conferência.
      previa: modo === 'dry' ? pendentes.slice(0, 8).map(x => ({ descricao: x.descricao, valor: x.valor, vencimento: x.data_vencimento, parcela: x.numero_parcela, total: x.total_parcelas, contato_id: x.contato_id, matched: x.matched, billingType: x.billingType })) : undefined,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
