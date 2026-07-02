// api/_eproc-peticionamento.js — Ponte entre o app e a extensão Chrome que
// protocola petições no eproc TJPR (Fase 2 eproc, Opção B: sessão logada).
// Despachado por api/automacao.js (?action=eproc-peticionamento) — não conta como
// Serverless Function própria (limite Hobby do Vercel). O vercel.json reescreve
// /api/eproc-peticionamento → /api/automacao?action=eproc-peticionamento.
//
// A extensão (rodando no navegador do advogado) chama este endpoint com o TOKEN
// de sessão Supabase do usuário (mesmo login do app). Toda leitura/escrita usa
// esse token contra o PostgREST → a RLS de proc_peticionamentos se aplica e a
// extensão só enxerga/mexe nos jobs do PRÓPRIO usuário (nunca service-role).
//
//   GET  /api/eproc-peticionamento?status=preparado
//        → lista jobs prontos + signed URL do PDF (bucket documentos) + metadados.
//   POST /api/eproc-peticionamento   body: { id, action, protocolo_num?, erro? }
//        action='claim'  → preparado → enviando (atômico; evita protocolar 2x)
//        action='done'   → enviando  → protocolado (+ protocolo_num, loga evento)
//        action='error'  → marca erro (libera p/ nova tentativa via re-preparar)
//
// Auth: requireUser (api/_auth.js) valida a sessão; o token segue para o PostgREST.

const { requireUser, applyCors } = require('./_auth.js');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || '';

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

// PostgREST com o token do usuário (RLS aplicada).
async function pgrest(token, path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`PostgREST ${path}: ${r.status} — ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

// Signed URL de um objeto do bucket `documentos` (RLS de storage aplicada).
async function signUrl(token, storagePath, expiresIn = 300) {
  const r = await fetch(`${SB_URL}/storage/v1/object/sign/documentos/${storagePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ expiresIn }),
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j || !j.signedURL) return null;
  return `${SB_URL}/storage/v1${j.signedURL}`;
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SB_URL || !ANON) return res.status(500).json({ error: 'Supabase não configurado no servidor.' });

  const user = await requireUser(req, res);
  if (!user) return; // requireUser já respondeu 401/5xx
  const token = bearer(req);

  try {
    if (req.method === 'GET') {
      const status = String(req.query?.status || 'preparado');
      // RLS restringe aos jobs do próprio usuário.
      const rows = await pgrest(token,
        `proc_peticionamentos?status=eq.${encodeURIComponent(status)}&select=id,cobranca_id,devedor_id,numero_processo,tipo,evento_eproc,pdf_path,dados_distribuicao,protocolo_num,created_at&order=created_at.asc`);
      const jobs = [];
      for (const j of (Array.isArray(rows) ? rows : [])) {
        const pdf_url = j.pdf_path ? await signUrl(token, j.pdf_path) : null;
        jobs.push({
          id: j.id,
          numero_processo: j.numero_processo,
          tipo: j.tipo,
          evento_eproc: j.evento_eproc,
          cobranca_id: j.cobranca_id,
          devedor_id: j.devedor_id,
          dados_distribuicao: j.dados_distribuicao || null,
          pdf_url,
        });
      }
      return res.status(200).json({ ok: true, jobs });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const id = body.id;
      const action = body.action;
      if (!id || !action) return res.status(400).json({ error: 'id e action obrigatórios' });

      if (action === 'claim') {
        // Atômico: só vira 'enviando' se ainda estiver 'preparado'.
        const upd = await pgrest(token,
          `proc_peticionamentos?id=eq.${encodeURIComponent(id)}&status=eq.preparado`,
          { method: 'PATCH', body: JSON.stringify({ status: 'enviando', updated_at: new Date().toISOString() }) });
        if (!Array.isArray(upd) || !upd[0]) {
          return res.status(409).json({ ok: false, error: 'job já em andamento ou inexistente' });
        }
        return res.status(200).json({ ok: true, claimed: true });
      }

      if (action === 'done') {
        const protocolo = String(body.protocolo_num || '').trim() || null;
        const upd = await pgrest(token,
          `proc_peticionamentos?id=eq.${encodeURIComponent(id)}&status=eq.enviando`,
          { method: 'PATCH', body: JSON.stringify({
            status: 'protocolado', protocolo_num: protocolo,
            protocolado_em: new Date().toISOString(), updated_at: new Date().toISOString(),
          }) });
        if (!Array.isArray(upd) || !upd[0]) {
          return res.status(409).json({ ok: false, error: 'job não estava em envio' });
        }
        // Log de auditoria (best-effort) — não derruba o report se falhar.
        const row = upd[0];
        if (row.devedor_id) {
          await pgrest(token, 'devedor_eventos', { method: 'POST', prefer: 'return=minimal',
            body: JSON.stringify({
              devedor_id: row.devedor_id, cobranca_id: row.cobranca_id || null,
              tipo: 'eproc_peticionado',
              payload: { protocolo: protocolo, numero_processo: row.numero_processo, peticionamento_id: id },
              autor_nome: 'eproc (extensão)',
            }) }).catch(() => {});
        }
        return res.status(200).json({ ok: true, protocolo });
      }

      if (action === 'error') {
        const erro = String(body.erro || '').slice(0, 1000);
        const upd = await pgrest(token,
          `proc_peticionamentos?id=eq.${encodeURIComponent(id)}`,
          { method: 'PATCH', body: JSON.stringify({ status: 'erro', erro, updated_at: new Date().toISOString() }) });
        if (!Array.isArray(upd) || !upd[0]) return res.status(404).json({ error: 'job não encontrado' });
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'action inválida' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[eproc-peticionamento]', String((e && e.message) || e));
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
