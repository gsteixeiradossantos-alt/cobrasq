// api/_custodia.js — Ciclo de vida das CUSTÓDIAS JUDICIAIS (dinheiro retido em juízo,
// fora do caixa livre). Despachado por automacao.js (?action=custodia&op=...).
//
// Ops:
//   registrar — cria a fin_custodia (status inicial + 1º evento no histórico).
//   avancar   — bloqueado→depositado→alvara (transição de situação + evento).
//   levantar  — alvara→levantado (alvará → conta Asaas; evento 'levantamento').
//   ratear    — levantado→rateado: divide o valor (−custas −honor. adv −honor. COBRASQ
//               = repasse ao cedente) e CRIA uma fin_operacao pendente (+ ponte
//               fin_lancamento) → o valor cai em Repasses › A revisar.
//
// Auth: proprietário logado. Migração: supabase/migrations/20260710_fin_custodia.sql.
// Nenhuma chave no front; service role só no servidor.

const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
const today = () => new Date().toISOString().slice(0, 10);
const ORDER = ['bloqueado', 'depositado', 'alvara', 'levantado', 'rateado'];
const ETAPA = { bloqueado: 'bloqueio', depositado: 'deposito', alvara: 'alvara', levantado: 'levantamento', rateado: 'rateio' };

async function getCustodia(id) {
  const rows = await sbFetch(`fin_custodia?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireUser(req, res);
  if (!user) return;

  // Gate de proprietário (service role ignora RLS).
  let papel = null;
  try {
    const rows = await sbFetch(`app_users?id=eq.${encodeURIComponent(user.id)}&select=papel`);
    papel = Array.isArray(rows) && rows[0] ? rows[0].papel : null;
  } catch (_e) { return res.status(500).json({ error: 'Não foi possível verificar permissão.' }); }
  if (papel !== 'proprietario') return res.status(403).json({ error: 'Apenas o proprietário pode operar custódias.' });

  const op = String(req.query.op || '');
  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});

  try {
    // ── registrar ────────────────────────────────────────────────
    if (op === 'registrar') {
      const valor = round2(body.valor);
      if (!(valor > 0)) return res.status(400).json({ error: 'valor inválido' });
      if (!body.processo_cnj) return res.status(400).json({ error: 'processo_cnj é obrigatório' });
      const status = ORDER.includes(body.status) ? body.status : 'bloqueado';
      const historico = [{ etapa: ETAPA[status], data: today(), valor, conta: status === 'levantado' ? 'Asaas' : null }];
      const row = {
        processo_cnj: String(body.processo_cnj).slice(0, 40),
        vara: body.vara || null,
        devedor_id: body.devedor_id || null,
        credor_id: body.credor_id || null,
        advogado: body.advogado || null,
        valor, status, historico, rateio: null,
        metadata: { criado_por: user.id },
      };
      const ins = await sbFetch('fin_custodia', { method: 'POST', body: JSON.stringify(row), prefer: 'return=representation' });
      const c = Array.isArray(ins) ? ins[0] : ins;
      return res.status(200).json({ ok: true, id: c && c.id });
    }

    // ── avancar (bloqueado→depositado→alvara) ───────────────────
    if (op === 'avancar') {
      const c = await getCustodia(body.id);
      if (!c) return res.status(404).json({ error: 'custódia não encontrada' });
      const to = body.to;
      const from = c.status;
      const okStep = (from === 'bloqueado' && to === 'depositado') || (from === 'depositado' && to === 'alvara');
      if (!okStep) return res.status(400).json({ error: `transição inválida: ${from} → ${to}` });
      const hist = Array.isArray(c.historico) ? c.historico.slice() : [];
      hist.push({ etapa: ETAPA[to], data: today(), valor: to === 'depositado' ? round2(c.valor) : null });
      await sbFetch(`fin_custodia?id=eq.${c.id}`, { method: 'PATCH', body: JSON.stringify({ status: to, historico: hist }) });
      return res.status(200).json({ ok: true, status: to });
    }

    // ── levantar (alvara→levantado) ─────────────────────────────
    if (op === 'levantar') {
      const c = await getCustodia(body.id);
      if (!c) return res.status(404).json({ error: 'custódia não encontrada' });
      if (c.status !== 'alvara') return res.status(400).json({ error: 'só é possível levantar após o alvará expedido' });
      const hist = Array.isArray(c.historico) ? c.historico.slice() : [];
      hist.push({ etapa: 'levantamento', data: today(), valor: round2(c.valor), conta: 'Asaas' });
      await sbFetch(`fin_custodia?id=eq.${c.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'levantado', historico: hist }) });
      return res.status(200).json({ ok: true, status: 'levantado' });
    }

    // ── ratear (levantado→rateado) + cria fin_operacao ──────────
    if (op === 'ratear') {
      const c = await getCustodia(body.id);
      if (!c) return res.status(404).json({ error: 'custódia não encontrada' });
      if (c.status !== 'levantado') return res.status(400).json({ error: 'rateio só após o levantamento' });
      const lev = round2(c.valor);
      const custas = round2(body.custas);
      const hadvPct = Math.max(0, Math.min(100, Number(body.honorarios_adv_pct) || 0));
      const hcobPct = Math.max(0, Math.min(100, Number(body.honorario_cobrasq_pct) || 0));
      const hadv = round2(lev * hadvPct / 100);
      const hcob = round2(lev * hcobPct / 100);
      const rep = round2(lev - custas - hadv - hcob);
      if (rep < 0) return res.status(400).json({ error: 'rateio negativo: descontos maiores que o valor levantado' });

      // fin_operacao: valor_recebido=levantado, valor_capital=repasse ao cedente,
      // valor_honorario=honorário COBRASQ. Nasce pendente → Repasses › A revisar.
      const opRow = {
        devedor_id: c.devedor_id || null,
        credor_id: c.credor_id || null,
        valor_recebido: lev,
        valor_capital: rep,
        valor_honorario: hcob,
        recebido_em: today(),
        recebimento_status: 'recebido',
        repasse_status: rep > 0 ? 'pendente' : 'nao_aplica',
        nf_status: 'pendente',
        metadata: { source: 'custodia', custodia_id: c.id, processo_cnj: c.processo_cnj, custas, honorarios_adv: hadv, honorarios_adv_pct: hadvPct, honorario_cobrasq_pct: hcobPct },
      };
      const insOp = await sbFetch('fin_operacao', { method: 'POST', body: JSON.stringify(opRow), prefer: 'return=representation' });
      const operacao = Array.isArray(insOp) ? insOp[0] : insOp;

      // Ponte fin_lancamento (receita do levantamento + despesa de repasse).
      let lancDespesaId = null;
      try {
        const rec = await sbFetch('fin_lancamento', { method: 'POST', prefer: 'return=representation', body: JSON.stringify({
          descricao: `Levantamento judicial — ${c.processo_cnj || 'custódia'}`,
          valor: lev, valor_pago: lev, tipo_movimento: 1, status: 1,
          data_competencia: today(), data_pagamento: today(),
        }) }).catch(() => null);
        const lancReceitaId = (rec && rec[0] && rec[0].id) || null;
        if (rep > 0) {
          const desp = await sbFetch('fin_lancamento', { method: 'POST', prefer: 'return=representation', body: JSON.stringify({
            descricao: `Repasse ao cedente (custódia) — ${c.processo_cnj || ''}`,
            valor: -rep, tipo_movimento: 0, status: 0,
            data_competencia: today(), data_vencimento: today(),
          }) }).catch(() => null);
          lancDespesaId = (desp && desp[0] && desp[0].id) || null;
        }
        if ((lancReceitaId || lancDespesaId) && operacao && operacao.id) {
          await sbFetch(`fin_operacao?id=eq.${operacao.id}`, { method: 'PATCH', body: JSON.stringify({ lancamento_receita_id: lancReceitaId, lancamento_despesa_id: lancDespesaId }) }).catch(() => {});
        }
      } catch (e) { console.warn('[custodia ratear] ponte fin_lancamento:', e.message); }

      const rateio = { levantado: lev, custas, honorarios_adv: hadv, honorarios_adv_pct: hadvPct, honorario_cobrasq: hcob, honorario_cobrasq_pct: hcobPct, repasse_cedente: rep };
      const hist = Array.isArray(c.historico) ? c.historico.slice() : [];
      hist.push({ etapa: 'rateio', data: today(), valor: rep });
      await sbFetch(`fin_custodia?id=eq.${c.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'rateado', rateio, historico: hist, fin_operacao_id: operacao ? operacao.id : null }) });

      return res.status(200).json({ ok: true, status: 'rateado', repasse_cedente: rep, honorario_cobrasq: hcob, operacao_id: operacao ? operacao.id : null });
    }

    return res.status(400).json({ error: 'op desconhecida: ' + op });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
