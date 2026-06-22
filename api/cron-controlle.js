// api/cron-controlle.js — Cron Vercel diário (06:00 UTC, ver vercel.json) que
// sincroniza Controlle → fin_* numa JANELA MÓVEL passado + futuro.
//
// Motor compartilhado em api/_controlle-sync.js (mesma lógica usada pela
// sincronização sob demanda em api/sync-controlle.js).
//
// A janela cobre PASSADO (mudanças recentes) e FUTURO (lançamentos agendados/
// previstos — a API filtra por data, então sem o futuro eles ficam de fora).
// LIMITAÇÃO: por ser janela por data, NÃO capta edições retroativas em itens
// antigos nem exclusões — reconciliação total = scripts/import_controlle.py (full).
//
// Auth: igual ao cron-regua (CRON_SECRET, comparação em tempo constante).
// Teste manual: GET /api/cron-controlle?dry=1   ·   ?past=30&future=365

const { runSync, controlleGet } = require('./_controlle-sync.js');

module.exports = async function handler(req, res) {
  const expect = process.env.CRON_SECRET || '';
  if (!expect) return res.status(500).json({ error: 'CRON_SECRET não configurado no servidor.' });
  const authHeader = req.headers['authorization'] || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const secret = req.headers['x-cron-secret'] || req.query?.secret || bearer || '';
  const crypto = require('crypto');
  const got = crypto.createHash('sha256').update(String(secret)).digest();
  const exp = crypto.createHash('sha256').update(String(expect)).digest();
  if (!crypto.timingSafeEqual(got, exp)) return res.status(401).json({ error: 'unauthorized' });

  if (!process.env.CONTROLLE_TOKEN) {
    return res.status(500).json({ error: 'CONTROLLE_TOKEN não configurado no servidor.' });
  }

  const dry = req.query?.dry === '1' || req.query?.dry === 'true';
  const pastDays = Math.min(3650, Math.max(1, parseInt(req.query?.past, 10) || 90));
  const futureDays = Math.min(3650, Math.max(0, parseInt(req.query?.future, 10) || 1095)); // ~3 anos
  const now = new Date();
  const startDate = new Date(now.getTime() - pastDays * 86400000).toISOString().slice(0, 10);
  const endDate = new Date(now.getTime() + futureDays * 86400000).toISOString().slice(0, 10);

  if (dry) {
    const acc = await controlleGet('/account/v1/accounts/');
    return res.status(200).json({
      ok: true, dry: true, janela: { startDate, endDate },
      contas_na_api: ((acc && acc.results) || []).length,
    });
  }

  try {
    const { totais } = await runSync({ startDate, endDate, notas: `cron -${pastDays}d..+${futureDays}d` });
    return res.status(200).json({ ok: true, janela: { startDate, endDate }, totais });
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.error('[cron-controlle]', msg);
    return res.status(500).json({ ok: false, error: msg });
  }
};
