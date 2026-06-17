// api/diagnostico-financeiro.js — Diagnóstico de "buracos" no financeiro. (PR9, parte
// de dados.) Read-only: aponta o que precisa de atenção e dá os números do mês. A
// camada visual (gráficos/cards na aba Relatórios e PDFs com identidade Cobrasq) é a
// parte de front-end, sobre estes números.
//
// Auth: usuário Supabase logado (RLS financeiro é proprietário-only de qualquer forma).

const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');

function sum(rows, field, abs) {
  return (rows || []).reduce((s, r) => s + (abs ? Math.abs(Number(r[field]) || 0) : (Number(r[field]) || 0)), 0);
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireUser(req, res);
  if (!user) return;

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';

  try {
    const [opsRepasse, opsNf, recVenc, despVenc, naoConc, opsMes] = await Promise.all([
      sbFetch(`fin_operacao?select=valor_capital&repasse_status=eq.pendente&limit=5000`).catch(() => []),
      sbFetch(`fin_operacao?select=id&nf_status=eq.pendente&limit=5000`).catch(() => []),
      sbFetch(`fin_lancamento?select=valor&tipo_movimento=eq.1&status=eq.0&data_vencimento=lt.${today}&limit=5000`).catch(() => []),
      sbFetch(`fin_lancamento?select=valor&tipo_movimento=eq.0&status=eq.0&data_vencimento=lt.${today}&limit=5000`).catch(() => []),
      sbFetch(`fin_lancamento?select=id&status=eq.1&conciliado=eq.false&limit=5000`).catch(() => []),
      sbFetch(`fin_operacao?select=valor_recebido,valor_honorario,valor_capital&recebido_em=gte.${monthStart}&limit=10000`).catch(() => []),
    ]);

    const diag = {
      ok: true,
      hoje: today,
      buracos: {
        operacoes_sem_repasse: { qtd: opsRepasse.length, total_capital: round2(sum(opsRepasse, 'valor_capital')) },
        operacoes_sem_nf: { qtd: opsNf.length },
        receitas_pendentes_vencidas: { qtd: recVenc.length, total: round2(sum(recVenc, 'valor', true)) },
        despesas_vencidas: { qtd: despVenc.length, total: round2(sum(despVenc, 'valor', true)) },
        lancamentos_pagos_nao_conciliados: { qtd: naoConc.length },
      },
      mes_corrente: {
        desde: monthStart,
        recebido: round2(sum(opsMes, 'valor_recebido')),
        honorario: round2(sum(opsMes, 'valor_honorario')),
        capital_a_repassar_ou_repassado: round2(sum(opsMes, 'valor_capital')),
        operacoes: opsMes.length,
      },
    };

    return res.status(200).json(diag);
  } catch (e) {
    console.error('[diagnostico-financeiro]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
