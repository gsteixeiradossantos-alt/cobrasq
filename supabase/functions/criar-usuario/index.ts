// Supabase Edge Function: criar-usuario
// Cria um novo usuário de acesso ao sistema (Auth + app_users + profiles).
// Chamada pelo botão Admin > "Criar usuário" (crm.html -> sb.functions.invoke('criar-usuario')).
// Antes esta função NÃO existia e o botão dava 404.
//
// verify_jwt: true — a função ainda revalida a sessão e o PAPEL do chamador por dentro
// (defesa em profundidade; verify_jwt sozinho não garante que o chamador seja admin).
//
// Contrato de entrada (o que o CRM manda hoje):
//   { nome: string, email: string, password: string, role: 'operador'|'admin' }
// Aliases tolerados (compat com index.html/legado): senha->password, papel->role.
//
// Autorização: SÓ o 'proprietario' (admin de fato) pode criar usuários. O papel é lido
// via service-role a partir do id do chamador (mesmo espírito do check de beatriz-msg,
// que valida a sessão com o token do usuário antes de agir).
//
// Mapeamento role (vocabulário do CRM) -> papel (vocabulário de app_users):
//   'admin'    -> papel 'proprietario'  + profiles.role 'admin'
//   'operador' -> papel 'colaborador'   + profiles.role 'operador'
//
// Setup: nenhum secret novo — usa SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
// (já disponíveis no runtime das Edge Functions).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// role do CRM -> { papel em app_users, role em profiles }
const ROLE_MAP: Record<string, { papel: string; profileRole: string }> = {
  admin: { papel: 'proprietario', profileRole: 'admin' },
  operador: { papel: 'colaborador', profileRole: 'operador' },
  // aliases defensivos: se o chamador já mandar o vocabulário de app_users
  proprietario: { papel: 'proprietario', profileRole: 'admin' },
  colaborador: { papel: 'colaborador', profileRole: 'operador' }
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    return json({ error: 'Ambiente Supabase incompleto no servidor.' }, 500);
  }

  // 1) Autentica o CHAMADOR com o token dele (respeita a sessão).
  const authHeader = req.headers.get('authorization') || '';
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } }
  });
  const { data: { user }, error: errAuth } = await userClient.auth.getUser();
  if (errAuth || !user) return json({ error: 'unauthorized' }, 401);

  // 2) Cliente service-role (para checar papel do chamador e criar o novo usuário).
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // 3) SÓ 'proprietario' pode criar usuários.
  const { data: caller, error: errCaller } = await admin
    .from('app_users')
    .select('papel, ativo')
    .eq('id', user.id)
    .maybeSingle();
  if (errCaller) return json({ error: 'falha ao verificar permissão' }, 500);
  if (!caller || caller.ativo === false || caller.papel !== 'proprietario') {
    return json({ error: 'forbidden: apenas o administrador pode criar usuários' }, 403);
  }

  // 4) Valida entrada.
  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: 'JSON inválido' }, 400); }

  const nome = String(body?.nome ?? '').trim();
  const email = String(body?.email ?? '').trim().toLowerCase();
  const password = String(body?.password ?? body?.senha ?? '');
  const roleRaw = String(body?.role ?? body?.papel ?? 'operador').trim().toLowerCase();
  const cargo = body?.cargo != null ? String(body.cargo).trim() : null;
  const refId = body?.ref_id != null ? String(body.ref_id).trim() : (body?.refId != null ? String(body.refId).trim() : null);

  if (nome.length < 2) return json({ error: 'nome inválido (mínimo 2 caracteres)' }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: 'e-mail inválido' }, 400);
  if (password.length < 6) return json({ error: 'senha inválida (mínimo 6 caracteres)' }, 400);
  const mapped = ROLE_MAP[roleRaw];
  if (!mapped) return json({ error: 'papel inválido (use operador ou admin)' }, 400);

  // 5) Cria o usuário no Auth (e-mail já confirmado; senha provisória).
  const { data: created, error: errCreate } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { nome, criado_por: user.id }
  });
  if (errCreate || !created?.user) {
    const msg = errCreate?.message || 'falha ao criar usuário no Auth';
    // e-mail duplicado é o erro mais comum -> mensagem amigável + 409.
    const dup = /already|exists|registered|duplicate/i.test(msg);
    return json({ error: dup ? 'já existe um usuário com este e-mail' : msg }, dup ? 409 : 400);
  }
  const novoId = created.user.id;

  // 6) Insere em app_users (fonte de papel/RLS) e profiles (perfil exibido no app).
  // Se o insert em app_users falhar, faz rollback do usuário do Auth para não deixar órfão.
  const { error: errApp } = await admin.from('app_users').insert({
    id: novoId,
    nome,
    papel: mapped.papel,
    cargo,
    ref_id: refId,
    email,
    ativo: true
  });
  if (errApp) {
    await admin.auth.admin.deleteUser(novoId).catch(() => {});
    return json({ error: 'falha ao gravar app_users: ' + errApp.message }, 500);
  }

  const { error: errProf } = await admin.from('profiles').insert({
    id: novoId,
    nome,
    email,
    role: mapped.profileRole,
    ativo: true
  });
  if (errProf) {
    // profiles é secundário; não derruba o usuário já criado, mas reporta.
    console.warn('[criar-usuario] app_users ok, profiles falhou: ' + errProf.message);
    return json({
      ok: true,
      user_id: novoId,
      email,
      papel: mapped.papel,
      warning: 'usuário criado, mas o perfil (profiles) não foi gravado: ' + errProf.message
    }, 200);
  }

  return json({ ok: true, user_id: novoId, email, papel: mapped.papel, role: mapped.profileRole }, 201);
});
