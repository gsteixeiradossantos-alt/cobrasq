// api/sync-controlle.js — Sincronização Controlle → fin_* SOB DEMANDA.
// Chamado pelo Financeiro (botão "Sincronizar agora" + disparo ao abrir a tela).
//
// Auth: sessão Supabase logada (requireUser) E papel = 'proprietario'
// (a escrita usa service role, que IGNORA RLS — por isso o gate é explícito aqui).
// Reusa o motor compartilhado api/_controlle-sync.js.
//
// Janela default: passado 90d + futuro 540d (~18 meses) — rápido o suficiente
// para abrir a tela. O cron diário (futuro ~3 anos) e o import_controlle.py (full)
// cobrem a cauda longa.

const { applyCors, requireUser } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');
const { runSync } = require('./_controlle-sync.js');

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireUser(req, res);
  if (!user) return; // requireUser já respondeu 401/5xx

  // Gate de proprietário (service role ignora RLS, então checamos aqui).
  let papel = null;
  try {
    const rows = await sbFetch(`app_users?id=eq.${encodeURIComponent(user.id)}&select=papel`);
    papel = Array.isArray(rows) && rows[0] ? rows[0].papel : null;
  } catch (e) {
    console.error('[sync-controlle] falha ao ler papel:', e.message);
    return res.status(500).json({ error: 'Não foi possível verificar permissão.' });
  }
  if (papel !== 'proprietario') {
    return res.status(403).json({ error: 'Apenas o proprietário pode sincronizar o financeiro.' });
  }

  if (!process.env.CONTROLLE_TOKEN) {
    return res.status(500).json({ error: 'CONTROLLE_TOKEN não configurado no servidor.' });
  }

  const pastDays = Math.min(3650, Math.max(1, parseInt(req.query?.past, 10) || 90));
  const futureDays = Math.min(3650, Math.max(0, parseInt(req.query?.future, 10) || 540));
  const now = new Date();
  const startDate = new Date(now.getTime() - pastDays * 86400000).toISOString().slice(0, 10);
  const endDate = new Date(now.getTime() + futureDays * 86400000).toISOString().slice(0, 10);

  try {
    const { totais } = await runSync({ startDate, endDate, notas: `sob-demanda -${pastDays}d..+${futureDays}d` });
    return res.status(200).json({ ok: true, janela: { startDate, endDate }, totais });
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.error('[sync-controlle]', msg);
    return res.status(500).json({ ok: false, error: msg });
  }
};
