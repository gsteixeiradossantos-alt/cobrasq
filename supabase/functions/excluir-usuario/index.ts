// Supabase Edge Function: excluir-usuario
// Exclui DEFINITIVAMENTE um usuário de acesso: apaga a conta do Supabase Auth, o que
// cascateia a linha de app_users (app_users.id REFERENCES auth.users(id) ON DELETE CASCADE).
// Chamada pelo botão Configurações → Usuários → "Excluir" (index.html -> usrExcluirUsuario).
//
// Por que precisa de Edge Function: apagar só a linha de app_users pelo navegador deixaria a
// conta viva no Auth — o e-mail continuaria "ocupado" e recriar o mesmo endereço daria 409.
// Só o service-role pode remover do Auth.
//
// verify_jwt: true — e a função ainda revalida sessão e PAPEL do chamador por dentro.
//
// Contrato: { user_id: string }  →  { ok: true, user_id } | { error, status }
//
// Travas (mesmas da tela, repetidas no servidor porque o cliente não é confiável):
//   - só 'proprietario' ativo pode excluir;
//   - ninguém exclui a si mesmo;
//   - não dá para excluir o último proprietário ATIVO.
//
// Referências de trabalho (quem criou acordo, quem lançou evento) bloqueiam ou apagam
// autoria: FKs de clientes.app_user_id, devedores.responsavel_id e
// solicitacoes_contato.atendido_por são NO ACTION (a exclusão FALHA, com aviso claro);
// devedores.assigned_to, acordos.criado_por e devedor_eventos.autor_id são SET NULL.
// Por isso a tela oferece "Desativar" como caminho normal e "Excluir" como exceção.

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: 'Ambiente Supabase incompleto no servidor.' }, 500);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // 1) Autentica o CHAMADOR pelo token do header. Passar o JWT explicitamente para
  // getUser(token) é obrigatório: getUser() sem argumento lê a sessão do storage —
  // que no runtime da Edge Function não existe — e devolve "Auth session missing".
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'unauthorized: sem token de sessão' }, 401);
  const { data: { user }, error: errAuth } = await admin.auth.getUser(token);
  if (errAuth || !user) return json({ error: 'unauthorized: sessão inválida ou expirada' }, 401);

  // 2) Só 'proprietario' ativo exclui usuários.
  const { data: caller, error: errCaller } = await admin
    .from('app_users').select('papel, ativo').eq('id', user.id).maybeSingle();
  if (errCaller) return json({ error: 'falha ao verificar permissão' }, 500);
  if (!caller || caller.ativo === false || caller.papel !== 'proprietario') {
    return json({ error: 'forbidden: apenas o administrador pode excluir usuários' }, 403);
  }

  // 3) Valida alvo.
  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: 'JSON inválido' }, 400); }
  const alvoId = String(body?.user_id ?? body?.id ?? '').trim();
  if (!alvoId) return json({ error: 'user_id obrigatório' }, 400);
  if (alvoId === user.id) return json({ error: 'você não pode excluir a própria conta' }, 400);

  const { data: alvo, error: errAlvo } = await admin
    .from('app_users').select('id, nome, email, papel, ativo').eq('id', alvoId).maybeSingle();
  if (errAlvo) return json({ error: 'falha ao carregar o usuário: ' + errAlvo.message }, 500);

  // 4) Trava do último administrador ativo (mesma regra de desativar).
  if (alvo && alvo.papel === 'proprietario' && alvo.ativo !== false) {
    const { count, error: errCount } = await admin
      .from('app_users').select('id', { count: 'exact', head: true })
      .eq('papel', 'proprietario').eq('ativo', true);
    if (!errCount && (count || 0) <= 1) {
      return json({ error: 'não é possível excluir o último administrador ativo' }, 409);
    }
  }

  // 5) Apaga do Auth — o ON DELETE CASCADE leva junto a linha de app_users.
  const { error: errDel } = await admin.auth.admin.deleteUser(alvoId);
  if (errDel) {
    const msg = errDel.message || String(errDel);
    // Conta já não existe no Auth (linha órfã em app_users): apaga o registro direto.
    if (/not found|user_not_found/i.test(msg)) {
      const { error: errRow } = await admin.from('app_users').delete().eq('id', alvoId);
      if (errRow) return json({ error: traduzFk(errRow.message) }, 409);
      return json({ ok: true, user_id: alvoId, nota: 'conta não existia no Auth; registro removido' }, 200);
    }
    // FK NO ACTION: o usuário tem trabalho vinculado e não pode ser apagado.
    return json({ error: traduzFk(msg) }, 409);
  }

  // 6) Confirma que a linha realmente saiu (o cascade é silencioso).
  const { data: sobrou } = await admin
    .from('app_users').select('id').eq('id', alvoId).maybeSingle();
  if (sobrou) {
    const { error: errRow } = await admin.from('app_users').delete().eq('id', alvoId);
    if (errRow) return json({ error: traduzFk(errRow.message) }, 409);
  }

  return json({ ok: true, user_id: alvoId, nome: alvo?.nome ?? null, email: alvo?.email ?? null }, 200);
});

// Erro de FK é ilegível para quem está na tela; traduz para a ação que resolve.
function traduzFk(msg: string): string {
  if (/foreign key|violates|referenced/i.test(msg)) {
    return 'este usuário tem registros vinculados (cliente, devedor sob responsabilidade ou '
      + 'atendimento) e não pode ser excluído. Use "Desativar" — bloqueia o login e preserva o histórico.';
  }
  return 'falha ao excluir: ' + msg;
}
