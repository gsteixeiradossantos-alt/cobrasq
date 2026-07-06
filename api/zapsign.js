// api/zapsign.js — Proxy server-to-server para a API do ZapSign
// Token em variável de ambiente (ZAPSIGN_TOKEN).
// Browser chama /api/zapsign?path=docs e este handler repassa pra
// https://api.zapsign.com.br/api/v1/{path}
// Onda 1b: exige login Supabase — antes qualquer requisição anônima criava/
// excluía documentos de assinatura e lia PII de contratos do escritório.

const { requireUser, applyCors } = require('./_auth.js');

module.exports = async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const user = await requireUser(req, res);
  if (!user) return;

  // Download passthrough dos arquivos do ZapSign (signed_file/original_file ficam
  // em S3 sem CORS — o navegador não consegue baixá-los direto). Só hosts do ZapSign.
  const fileUrl = req.query.fileUrl || '';
  if (fileUrl) {
    let u;
    try { u = new URL(fileUrl); } catch (_) { return res.status(400).json({ error: 'fileUrl inválida' }); }
    const hostOk = u.protocol === 'https:' && (
      u.hostname.endsWith('.zapsign.com.br') ||
      (u.hostname.endsWith('.s3.amazonaws.com') && /zapsign/i.test(u.hostname)) ||
      (u.hostname === 's3.amazonaws.com' && /^\/zapsign/i.test(u.pathname))
    );
    if (!hostOk) return res.status(400).json({ error: 'host não permitido para download' });
    try {
      const rr = await fetch(fileUrl);
      if (!rr.ok) return res.status(502).json({ error: 'download falhou: HTTP ' + rr.status });
      const buf = Buffer.from(await rr.arrayBuffer());
      res.setHeader('Content-Type', rr.headers.get('content-type') || 'application/pdf');
      return res.status(200).send(buf);
    } catch (e) {
      return res.status(502).json({ error: 'download falhou: ' + (e && e.message || e) });
    }
  }

  // Credencial SÓ via env var (gestor confirmou ZAPSIGN_TOKEN setada no Vercel).
  const token = process.env.ZAPSIGN_TOKEN || '';
  const pathParam = (req.query.path || '').replace(/^\/+/, '');

  if (!token) {
    return res.status(500).json({
      error: 'ZAPSIGN_TOKEN não configurada no servidor.',
      hint: 'Defina a variável de ambiente ZAPSIGN_TOKEN no painel da Vercel.'
    });
  }
  if (!pathParam) {
    return res.status(400).json({ error: 'query param ?path= ausente' });
  }
  // P3 (auditoria 2026-06) — só caracteres de path esperados; bloqueia traversal.
  if (pathParam.includes('..') || !/^[A-Za-z0-9/_.-]+$/.test(pathParam)) {
    return res.status(400).json({ error: 'path inválido' });
  }

  const forwardQuery = { ...req.query };
  delete forwardQuery.path;
  const qs = new URLSearchParams(forwardQuery).toString();
  const upstreamUrl = `https://api.zapsign.com.br/api/v1/${pathParam}${qs ? '?' + qs : ''}`;

  try {
    const fetchOpts = {
      method: req.method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };

    if (!['GET', 'DELETE', 'HEAD'].includes(req.method) && req.body) {
      fetchOpts.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const upstream = await fetch(upstreamUrl, fetchOpts);
    const text = await upstream.text();

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('[zapsign proxy] erro upstream:', err.message);
    res.status(502).json({ error: 'Falha ao conectar ao ZapSign. Tente novamente.' });
  }
};
