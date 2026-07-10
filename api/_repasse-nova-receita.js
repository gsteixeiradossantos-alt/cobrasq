// api/_repasse-nova-receita.js — Cadastro MANUAL de uma receita recebida no módulo
// "Repasses a clientes" (tela 03 "Nova receita"). Espelha o insert do webhook
// (_processar-recebimento): cria a fin_operacao (recebida) com o split capital/
// honorário e a ponte fin_lancamento (receita + despesa de repasse), nascendo como
// SUGESTÃO pendente em "A revisar" quando há capital a repassar.
//
// Regra do módulo: capital → cliente; juros/multa/encargos → honorário. O honorário é
// sempre valor_recebido − valor_capital (não é % fixo). O repasse NÃO é disparado aqui
// (nasce 'pendente'); o PIX sai depois em /api/repassar (1 por devedor).
//
// Auth: proprietário logado. Despachado por automacao.js (?action=repasse-nova-receita).
// A service role do Supabase fica só no servidor (env). Nenhuma chave no front.

const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
    return res.status(403).json({ error: 'Apenas o proprietário pode cadastrar receitas de repasse.' });
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const valorRecebido = round2(body.valor_recebido);
  if (!(valorRecebido > 0)) return res.status(400).json({ error: 'valor_recebido inválido' });
  if (!body.credor_id) return res.status(400).json({ error: 'credor_id (cliente/cedente) é obrigatório para o repasse' });

  // Capital → cliente. Honorário = recebido − capital (sempre). Capital limitado ao recebido.
  const valorCapital = round2(Math.min(Math.max(Number(body.valor_capital) || 0, 0), valorRecebido));
  const valorHonorario = round2(valorRecebido - valorCapital);
  const repasseStatus = valorCapital > 0 ? 'pendente' : 'nao_aplica';
  const recebidoEm = (body.recebido_em && String(body.recebido_em).slice(0, 10)) || new Date().toISOString().slice(0, 10);
  const descricao = String(body.descricao || 'Acordo — parcela recebida').slice(0, 200);

  try {
    const row = {
      acordo_id: body.acordo_id || null,
      devedor_id: body.devedor_id || null,
      credor_id: body.credor_id,
      parcela: body.parcela || null,
      total_parcelas: body.total_parcelas || null,
      valor_recebido: valorRecebido,
      valor_capital: valorCapital,
      valor_honorario: valorHonorario,
      recebido_em: recebidoEm,
      recebimento_status: 'recebido',
      repasse_status: repasseStatus,
      nf_status: 'pendente',
      metadata: { source: 'manual-nova-receita', criado_por: user.id, descricao },
    };
    const inserted = await sbFetch('fin_operacao', { method: 'POST', body: JSON.stringify(row), prefer: 'return=representation' });
    const operacao = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!operacao || !operacao.id) return res.status(500).json({ error: 'Falha ao inserir a operação.' });

    // Ponte fin_lancamento (receita paga + despesa de repasse pendente), igual ao webhook.
    try {
      const parcTxt = row.parcela && row.total_parcelas ? ` ${row.parcela}/${row.total_parcelas}` : '';
      const rec = await sbFetch('fin_lancamento', { method: 'POST', body: JSON.stringify({
        descricao: `Recebimento — ${descricao}${parcTxt}`,
        valor: valorRecebido, valor_pago: valorRecebido,
        tipo_movimento: 1, status: 1,
        data_competencia: recebidoEm, data_pagamento: recebidoEm,
        numero_parcela: row.parcela, total_parcelas: row.total_parcelas,
      }), prefer: 'return=representation' }).catch(() => null);
      const lancReceitaId = (rec && rec[0] && rec[0].id) || null;
      let lancDespesaId = null;
      if (valorCapital > 0) {
        const desp = await sbFetch('fin_lancamento', { method: 'POST', body: JSON.stringify({
          descricao: `Repasse ao cliente${parcTxt}`,
          valor: -valorCapital,
          tipo_movimento: 0, status: 0,
          data_competencia: recebidoEm, data_vencimento: recebidoEm,
          numero_parcela: row.parcela, total_parcelas: row.total_parcelas,
        }), prefer: 'return=representation' }).catch(() => null);
        lancDespesaId = (desp && desp[0] && desp[0].id) || null;
      }
      if (lancReceitaId || lancDespesaId) {
        await sbFetch(`fin_operacao?id=eq.${operacao.id}`, { method: 'PATCH', body: JSON.stringify({ lancamento_receita_id: lancReceitaId, lancamento_despesa_id: lancDespesaId }) }).catch(() => {});
      }
    } catch (e) { console.warn('[repasse-nova-receita] ponte fin_lancamento:', e.message); }

    return res.status(200).json({
      ok: true,
      operacao_id: operacao.id,
      valor_recebido: valorRecebido,
      valor_capital: valorCapital,
      valor_honorario: valorHonorario,
      repasse_status: repasseStatus,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
