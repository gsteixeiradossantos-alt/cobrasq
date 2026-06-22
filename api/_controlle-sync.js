// api/_controlle-sync.js — Motor de sincronização Controlle → Supabase (fin_*).
// Compartilhado pelo cron diário (api/cron-controlle.js) e pela sincronização
// SOB DEMANDA (api/sync-controlle.js). NÃO é exposto diretamente (prefixo _).
//
// Idempotente: upsert por controlle_id / controlle_payment_id (nunca duplica).
// A janela é por DATA (start_date/end_date no campo "date" da API); por isso
// quem chama deve incluir o FUTURO para pegar lançamentos agendados/previstos.
// Edições retroativas em itens antigos e exclusões no Controlle NÃO são captadas
// por janela — reconciliação total = scripts/import_controlle.py (full).

const { sbFetch } = require('./_sb.js');

const CTRL_BASE = 'https://api-v1.controlle.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP Controlle ──────────────────────────────────────────────
async function controlleGet(path, retry = 2) {
  const token = process.env.CONTROLLE_TOKEN || '';
  if (!token) throw new Error('CONTROLLE_TOKEN não configurado no servidor.');
  const url = path.startsWith('http') ? path : CTRL_BASE + path;
  for (let i = 0; i <= retry; i++) {
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'COBRASQ-Sync/1.0',
      },
    });
    if (r.status === 429) { await sleep(5000); continue; } // rate-limit: backoff curto
    const text = await r.text();
    if (!r.ok) throw new Error(`Controlle ${r.status} em ${path}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return {}; }
  }
  throw new Error(`Controlle: esgotou retries em ${path}`);
}

// ── Helpers Supabase (PostgREST via _sb.js / service role) ──────
async function sbUpsert(table, rows, onConflict, chunk = 500) {
  if (!rows.length) return 0;
  let n = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const batch = rows.slice(i, i + chunk);
    await sbFetch(`${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      body: JSON.stringify(batch),
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    n += batch.length;
  }
  return n;
}

async function sbInsert(table, rows, chunk = 500) {
  if (!rows.length) return 0;
  let n = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const batch = rows.slice(i, i + chunk);
    await sbFetch(table, { method: 'POST', body: JSON.stringify(batch), prefer: 'return=minimal' });
    n += batch.length;
  }
  return n;
}

async function sbSelect(table, params) {
  const qs = new URLSearchParams(params).toString();
  return sbFetch(`${table}?${qs}`);
}

async function sbUpdate(table, patch, filterQs) {
  return sbFetch(`${table}?${filterQs}`, { method: 'PATCH', body: JSON.stringify(patch), prefer: 'return=minimal' });
}

async function sbDelete(table, filterQs) {
  return sbFetch(`${table}?${filterQs}`, { method: 'DELETE', prefer: 'return=minimal' });
}

async function sbIdMap(table, controlleField = 'controlle_id') {
  const out = {};
  let offset = 0;
  const page = 1000;
  for (;;) {
    const rows = await sbFetch(`${table}?select=id,${controlleField}&limit=${page}&offset=${offset}`);
    if (!rows || !rows.length) break;
    for (const r of rows) { if (r[controlleField] != null) out[r[controlleField]] = r.id; }
    if (rows.length < page) break;
    offset += page;
  }
  return out;
}

// Liga parent_id interno apenas onde ainda está nulo (rápido em regime permanente).
// Movimentações de pai já existente são reconciliadas pelo import_controlle.py.
async function relinkParents(table, items, getId, getParentControlleId) {
  const rows = await sbFetch(`${table}?select=id,controlle_id,parent_id`);
  const idByCtrl = {};
  const parentById = {};
  for (const r of (rows || [])) {
    if (r.controlle_id != null) idByCtrl[r.controlle_id] = r.id;
    parentById[r.id] = r.parent_id;
  }
  for (const c of items) {
    const internal = idByCtrl[getId(c)];
    const pcid = getParentControlleId(c);
    const parentInternal = pcid != null ? idByCtrl[pcid] : null;
    if (internal && parentInternal && parentById[internal] == null) {
      await sbUpdate(table, { parent_id: parentInternal }, `id=eq.${internal}`);
    }
  }
}

const parseDate = (v) => (v ? String(v).slice(0, 10) : null);
const cents = (v) => (v == null ? null : Number(v) / 100);

// ── Loaders (dimensões íntegras — são pequenas e mudam pouco) ───
async function loadCategorias() {
  const j = await controlleGet('/plan-account/v1/planAccountsEntities/');
  const items = j.results || [];
  const rows = items.map((c) => ({
    controlle_id: c.id,
    controlle_parent_id: c.id_plan_accounts_parent ?? null,
    descricao: c.ds_category || '(sem descrição)',
    nivel: c.level || 1,
    tipo_movimento: c.movement || 0,
    classificacao: c.classification ?? null,
    natureza: c.nature ?? null,
    cor: c.color ?? null,
    is_father: !!c.is_father,
    ativa: (c.status ?? 1) === 1,
    raw_payload: c,
  }));
  const n = await sbUpsert('fin_categoria', rows, 'controlle_id');
  await relinkParents('fin_categoria', items, (c) => c.id, (c) => c.id_plan_accounts_parent);
  return n;
}

async function loadCentrosCusto() {
  const j = await controlleGet('/cost-center/v1/costCenters/');
  const items = j.results || [];
  const rows = items.map((c) => ({
    controlle_id: c.id_cost_centers,
    controlle_parent_id: c.id_cost_centers_parent ?? null,
    descricao: c.ds_cost_center || '(sem descrição)',
    raw_payload: c,
  }));
  const n = await sbUpsert('fin_centro_custo', rows, 'controlle_id');
  await relinkParents('fin_centro_custo', items, (c) => c.id_cost_centers, (c) => c.id_cost_centers_parent);
  return n;
}

async function loadContas() {
  const j = await controlleGet('/account/v1/accounts/');
  const items = j.results || [];
  const rows = items.map((c) => ({
    controlle_id: c.id,
    descricao: c.ds_account || '(sem descrição)',
    banco_id: c.id_institution_financial ?? null,
    banco_nome: c.ds_institution_financial ?? null,
    agencia: c.agency_account ?? null,
    numero: c.number_account ?? null,
    tipo: c.type || 0,
    default_conta: !!c.default,
    ativa: (c.status ?? 1) === 1,
    saldo_inicial: cents(c.bank_balance) || 0,
    observacoes: c.obs_account ?? null,
    raw_payload: c,
  }));
  return sbUpsert('fin_conta', rows, 'controlle_id');
}

async function loadContatos() {
  let total = 0;
  let page = 1;
  for (;;) {
    const j = await controlleGet(`/contact/v1/contacts/listContacts/?numberPage=${page}`);
    const contacts = (j.results && j.results.contacts) || [];
    if (!contacts.length) break;
    const rows = contacts.map((c) => ({
      controlle_id: c.id_contact,
      nome: c.name || '(sem nome)',
      documento: c.document || c.cpf_cnpj || null,
      email: c.email ?? null,
      telefone: c.phone ?? null,
      ativo: (c.situation ?? 1) === 1,
      raw_payload: c,
    }));
    total += await sbUpsert('fin_contato', rows, 'controlle_id');
    if (contacts.length < 30) break; // página fixa de 30
    page++;
  }
  return total;
}

// ── Lançamentos (janela passado+futuro) + rateios + recorrências ──
async function loadLancamentos(startDate, endDate) {
  const contaMap = await sbIdMap('fin_conta');
  const contatoMap = await sbIdMap('fin_contato');
  const categoriaMap = await sbIdMap('fin_categoria');
  const ccMap = await sbIdMap('fin_centro_custo');

  let total = 0;
  let rateioCat = 0;
  let rateioCc = 0;
  const recIds = new Set();

  let page = 1;
  for (;;) {
    const url = `/transaction/v1/transactions/list/?start_date=${startDate}`
      + `&end_date=${endDate}&page=${page}&orderBy=date&orderByCardinality=DESC`;
    const j = await controlleGet(url);
    const lst = (j.results && j.results.transactionsList) || [];
    if (!lst.length) break;

    const lancRows = lst
      .filter((t) => t.id_transactions_payments != null)
      .map((t) => {
        if (t.id_transactions_recurrences) recIds.add(t.id_transactions_recurrences);
        return {
          controlle_payment_id: t.id_transactions_payments,
          controlle_transaction_id: t.id_transactions ?? null,
          controlle_recurrence_id: t.id_transactions_recurrences ?? null,
          uuid: t.uuid_transactions_payments ?? null,
          descricao: t.ds_transaction || '(sem descrição)',
          data_competencia: parseDate(t.dt_competence),
          data_vencimento: parseDate(t.dt_due),
          data_pagamento: parseDate(t.dt_billing),
          valor: cents(t.value_in_cent) || 0,
          valor_pago: cents(t.payment_in_cent),
          juros: cents(t.fees_in_cent),
          multa: cents(t.fines_in_cent),
          desconto: cents(t.discount_in_cent),
          tipo_movimento: t.activity_type || 0,
          status: t.situation || 0,
          conta_id: contaMap[t.id_accounts_main] ?? null,
          contato_id: contatoMap[t.id_contacts] ?? null,
          numero_parcela: t.repeat_index ?? null,
          total_parcelas: t.repeat_total ?? null,
          recorrencia_fixa: !!t.recurrence_fixed,
          conciliado: !!t.is_conciled,
          tem_rateio: !!t.has_apportionment,
          is_pagamento_parcial: !!t.is_payment_partial,
          observacoes: t.obs_transaction ?? null,
          raw_payload: t,
        };
      });

    await sbUpsert('fin_lancamento', lancRows, 'controlle_payment_id');
    total += lancRows.length;

    // Resolve IDs internos para reescrever os rateios desta página.
    const paymentIds = lst.map((t) => t.id_transactions_payments).filter(Boolean);
    if (paymentIds.length) {
      const inserted = await sbSelect('fin_lancamento', {
        select: 'id,controlle_payment_id',
        controlle_payment_id: `in.(${paymentIds.join(',')})`,
        limit: String(paymentIds.length + 10),
      });
      const lancMap = {};
      for (const r of (inserted || [])) lancMap[r.controlle_payment_id] = r.id;

      const cats = [];
      const ccs = [];
      for (const t of lst) {
        const lid = lancMap[t.id_transactions_payments];
        if (!lid) continue;
        for (const a of (t.apportionments_plan_account || [])) {
          cats.push({
            lancamento_id: lid,
            categoria_id: categoriaMap[a.id_category] ?? null,
            controlle_apportionment_id: a.id ?? null,
            controlle_categoria_id: a.id_category ?? null,
            valor: cents(a.value) || 0,
          });
        }
        for (const a of (t.apportionments_cost_center || [])) {
          const ccid = a.id_cost_center ?? a.id_cost_centers ?? null;
          ccs.push({
            lancamento_id: lid,
            centro_custo_id: ccMap[ccid] ?? null,
            controlle_apportionment_id: a.id ?? null,
            controlle_centro_custo_id: ccid,
            valor: cents(a.value) || 0,
          });
        }
      }

      // delete + insert (reescreve rateios dos lançamentos tocados) — idempotente.
      if (cats.length) {
        const lids = [...new Set(cats.map((c) => c.lancamento_id))];
        await sbDelete('fin_lancamento_categoria', `lancamento_id=in.(${lids.join(',')})`);
        await sbInsert('fin_lancamento_categoria', cats);
        rateioCat += cats.length;
      }
      if (ccs.length) {
        const lids = [...new Set(ccs.map((c) => c.lancamento_id))];
        await sbDelete('fin_lancamento_centro_custo', `lancamento_id=in.(${lids.join(',')})`);
        await sbInsert('fin_lancamento_centro_custo', ccs);
        rateioCc += ccs.length;
      }
    }

    if (lst.length < 100) break; // última página da janela
    page++;
  }

  // Templates de recorrência sintéticos — só para as recorrências vistas nesta janela.
  let recCount = 0;
  for (const rid of recIds) {
    const sample = await sbSelect('fin_lancamento', {
      select: 'descricao,valor,tipo_movimento,conta_id,contato_id,data_competencia',
      controlle_recurrence_id: `eq.${rid}`,
      order: 'data_competencia.asc',
      limit: '1',
    });
    if (!sample || !sample.length) continue;
    const s = sample[0];
    await sbUpsert('fin_recorrencia_template', [{
      controlle_id: rid,
      descricao: s.descricao,
      valor: s.valor,
      tipo_movimento: s.tipo_movimento,
      conta_id: s.conta_id,
      contato_id: s.contato_id,
      data_inicio: s.data_competencia,
    }], 'controlle_id');
    recCount++;
  }
  if (recCount) {
    const tplMap = await sbIdMap('fin_recorrencia_template');
    for (const rid of recIds) {
      const tplId = tplMap[rid];
      if (tplId) await sbUpdate('fin_lancamento', { recorrencia_template_id: tplId }, `controlle_recurrence_id=eq.${rid}`);
    }
  }

  return { lancamentos: total, rateio_categoria: rateioCat, rateio_centro_custo: rateioCc, recorrencia_templates: recCount };
}

// ── Orquestrador: roda todos os loaders e registra em fin_sync_log ──
async function runSync({ startDate, endDate, notas }) {
  const log = await sbFetch('fin_sync_log', {
    method: 'POST', body: JSON.stringify({ notas: notas || 'sync' }), prefer: 'return=representation',
  });
  const logId = Array.isArray(log) ? log[0].id : (log && log.id);
  const totais = {};
  const erros = [];
  try {
    totais.categorias = await loadCategorias();
    totais.centros_custo = await loadCentrosCusto();
    totais.contas = await loadContas();
    totais.contatos = await loadContatos();
    Object.assign(totais, await loadLancamentos(startDate, endDate));
    if (logId) {
      await sbUpdate('fin_sync_log', { finalizado_em: new Date().toISOString(), ok: true, totais, erros }, `id=eq.${logId}`);
    }
    return { ok: true, totais, logId };
  } catch (e) {
    const msg = String((e && e.message) || e);
    erros.push({ message: msg });
    if (logId) {
      try {
        await sbUpdate('fin_sync_log', { finalizado_em: new Date().toISOString(), ok: false, totais, erros }, `id=eq.${logId}`);
      } catch { /* não mascara o erro original */ }
    }
    throw e;
  }
}

module.exports = { runSync, controlleGet };
