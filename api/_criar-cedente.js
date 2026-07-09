// api/_criar-cedente.js — cria/ativa o acesso de um CEDENTE (cliente credor) ao portal.
// Owner-only. Cria o usuário no Supabase Auth (GoTrue admin, service role), registra
// app_users{papel:'cedente', ref_id:clienteId} e liga clientes.app_user_id = uid.
// A RLS por cliente (clientes/devedores/cobrancas/repasses/documentos) faz o resto.
// Despachado por api/automacao.js (?action=criar-cedente). Sem nova função Vercel.

const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1) sessão válida
  const user = await requireUser(req, res);
  if (!user) return;

  // 2) só o proprietário pode criar acesso de cedente
  try {
    const rows = await sbFetch(`app_users?id=eq.${user.id}&select=papel`);
    const papel = Array.isArray(rows) && rows[0] ? rows[0].papel : null;
    if (papel !== 'proprietario') {
      return res.status(403).json({ error: 'Apenas o proprietário pode ativar o acesso do cedente.' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Falha ao verificar permissão: ' + e.message });
  }

  // 3) entrada
  const body = (typeof req.body === 'object' && req.body) || {};
  const clienteId = String(body.clienteId || '').trim();
  const grupoEconomicoId = String(body.grupoEconomicoId || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const senha = String(body.senha || '');
  const nome = String(body.nome || '').trim();
  if ((!clienteId && !grupoEconomicoId) || !email || senha.length < 6) {
    return res.status(400).json({ error: 'Informe clienteId ou grupoEconomicoId, e-mail e senha (mín. 6 caracteres).' });
  }
  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ error: 'Servidor sem SUPABASE_SERVICE_ROLE_KEY configurada.' });
  }

  // 4) valida o alvo: cliente único OU grupo econômico
  let cliente = null;
  if (clienteId) {
    try {
      const cs = await sbFetch(`clientes?id=eq.${clienteId}&select=id,nome,nome_fantasia,app_user_id`);
      cliente = Array.isArray(cs) && cs[0] ? cs[0] : null;
      if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado.' });
    } catch (e) {
      return res.status(500).json({ error: 'Falha ao buscar cliente: ' + e.message });
    }
  } else {
    try {
      const gs = await sbFetch(`grupos_economicos?id=eq.${grupoEconomicoId}&select=id,nome`);
      if (!(Array.isArray(gs) && gs[0])) return res.status(404).json({ error: 'Grupo econômico não encontrado.' });
    } catch (e) {
      return res.status(500).json({ error: 'Falha ao buscar grupo: ' + e.message });
    }
  }

  // 5) cria o usuário no GoTrue (admin). Já confirma o e-mail p/ permitir login imediato.
  let uid;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: senha, email_confirm: true,
        user_metadata: { nome: nome || (cliente && (cliente.nome_fantasia || cliente.nome)) || '', papel: 'cedente' } }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data && data.id) {
      uid = data.id;
    } else if (r.status === 422 || /already.*regist|exists/i.test(JSON.stringify(data))) {
      // e-mail já existe no Auth: localiza o uid para reativar/religar (idempotente).
      const lr = await fetch(`${SB_URL}/auth/v1/admin/users?per_page=200`, {
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      });
      const lj = await lr.json().catch(() => ({}));
      const users = (lj && (lj.users || lj)) || [];
      const ex = Array.isArray(users) ? users.find(u => (u.email || '').toLowerCase() === email) : null;
      if (!ex) return res.status(409).json({ error: 'E-mail já cadastrado no Auth, mas não consegui localizá-lo. Use outro e-mail.' });
      uid = ex.id;
      // redefine a senha do usuário existente para a informada agora
      await fetch(`${SB_URL}/auth/v1/admin/users/${uid}`, {
        method: 'PUT', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: senha, email_confirm: true }),
      }).catch(() => {});
    } else {
      return res.status(502).json({ error: 'Falha ao criar usuário no Auth: ' + (data.msg || data.error_description || JSON.stringify(data)) });
    }
  } catch (e) {
    return res.status(502).json({ error: 'Erro ao criar usuário: ' + e.message });
  }

  // 6) app_users (papel cedente). Cliente único → ref_id + clientes.app_user_id.
  //    Grupo econômico → grupo_economico_id + pode_ver_grupo (RLS *_cedente_grupo).
  try {
    const appRow = grupoEconomicoId
      ? { id: uid, nome: nome || 'Cedente do grupo', papel: 'cedente', grupo_economico_id: grupoEconomicoId, pode_ver_grupo: true, ativo: true }
      : { id: uid, nome: nome || cliente.nome_fantasia || cliente.nome || '', papel: 'cedente', ref_id: clienteId, ativo: true };
    await sbFetch('app_users?on_conflict=id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: JSON.stringify(appRow),
    });
    if (clienteId) {
      await sbFetch(`clientes?id=eq.${clienteId}`, {
        method: 'PATCH',
        body: JSON.stringify({ app_user_id: uid }),
      });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Usuário criado, mas falhou ao vincular: ' + e.message });
  }

  return res.status(200).json({ ok: true, userId: uid, email });
};
