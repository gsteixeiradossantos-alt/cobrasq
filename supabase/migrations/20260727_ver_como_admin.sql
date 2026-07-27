-- ============================================================================
-- "Ver como" (Administrador) — sessão REAL para pré-visualizar colaborador/
-- cedente/devedor, com log de auditoria. NÃO aplicar sem revisão.
-- ============================================================================
-- Contexto: o Administrador (papel 'proprietario') pediu uma forma de ver o
-- sistema exatamente como outro usuário veria (RLS/RPC batendo 100%), sem
-- fazer login de verdade (senha/2FA da pessoa). Desenho:
--
--   - Devedor (não tem Supabase Auth, só o token de `portal_sessoes`): a
--     função `admin_emitir_sessao_portal` abaixo reusa o MESMO mecanismo que
--     `portal_login_nascimento` usa de verdade (`_portal_emitir_sessao`),
--     só que gated a proprietario — token real, sem precisar do CPF+nascimento.
--     É o único caso com sessão 100% real nesta primeira leva.
--   - Colaborador/Cedente (têm login Supabase Auth real): ficaram só na versão
--     aproximada (filtro/roteamento client-side, sem trocar sessão — ver
--     viewAsIniciar() no index.html). Um caminho de sessão real pra esses dois
--     (magic link + Edge Function) foi desenhado mas não implementado nesta
--     leva; `ver_como_log` já aceita 'colaborador'/'cedente' em `alvo_tipo`
--     pra não precisar de migração nova se isso for retomado depois.
--
-- Toda ativação grava uma linha em `ver_como_log` (quem, quem virou, quando
-- começou/terminou) — é o jeito de não virar ponto cego de auditoria.
--
-- ROLLBACK: ver 20260727_ver_como_admin_rollback.sql
-- Aplicar manual no SQL Editor do Supabase APÓS revisão. NÃO rodar db push cego.
-- ============================================================================

create table if not exists public.ver_como_log (
  id            uuid primary key default gen_random_uuid(),
  admin_id      uuid not null,
  admin_nome    text,
  alvo_tipo     text not null check (alvo_tipo in ('colaborador','cedente','devedor')),
  alvo_id       uuid not null,
  alvo_nome     text,
  iniciado_em   timestamptz not null default now(),
  encerrado_em  timestamptz
);
create index if not exists idx_ver_como_log_admin on public.ver_como_log(admin_id, iniciado_em desc);

alter table public.ver_como_log enable row level security;
-- Sem policy de propósito: só as funções SECURITY DEFINER / service-role tocam a tabela.
-- Se um dia precisar de uma tela de auditoria no app, adiciona policy de leitura pra proprietario aqui.

-- ── Devedor: emite sessão REAL do portal (mesmo mecanismo de portal_login_nascimento) ──
create or replace function public.admin_emitir_sessao_portal(p_devedor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller_papel text;
  v_admin_nome text;
  v_dev record;
  v_sessao jsonb;
begin
  select papel, nome into v_caller_papel, v_admin_nome from public.app_users where id = auth.uid();
  if v_caller_papel is distinct from 'proprietario' then
    return jsonb_build_object('ok', false, 'erro', 'forbidden: apenas o administrador pode usar Ver como');
  end if;

  select id, nome, doc into v_dev from public.devedores where id = p_devedor_id;
  if v_dev.id is null then
    return jsonb_build_object('ok', false, 'erro', 'devedor não encontrado');
  end if;

  v_sessao := public._portal_emitir_sessao(v_dev.id, regexp_replace(coalesce(v_dev.doc, ''), '\D', '', 'g'));

  insert into public.ver_como_log (admin_id, admin_nome, alvo_tipo, alvo_id, alvo_nome)
  values (auth.uid(), v_admin_nome, 'devedor', v_dev.id, v_dev.nome);

  return jsonb_build_object(
    'ok', true,
    'sessao_token', v_sessao->>'sessao_token',
    'expira_em', v_sessao->>'expira_em',
    'nome', v_dev.nome
  );
end;
$function$;

revoke all on function public.admin_emitir_sessao_portal(uuid) from public;
grant execute on function public.admin_emitir_sessao_portal(uuid) to authenticated;

-- ── Fecha o registro de auditoria (chamado ao sair da pré-visualização) ──
create or replace function public.admin_encerrar_ver_como(p_log_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.ver_como_log
     set encerrado_em = now()
   where id = p_log_id
     and admin_id = auth.uid()
     and encerrado_em is null;
  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.admin_encerrar_ver_como(uuid) from public;
grant execute on function public.admin_encerrar_ver_como(uuid) to authenticated;
