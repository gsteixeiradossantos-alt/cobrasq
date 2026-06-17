-- 20260617_03_advisors_security_fixes.sql
-- Correções de segurança apontadas pelos Supabase advisors (auditoria 2026-06).
-- Ver docs/AUDITORIA-2026-06.md (seção 1.1).
--
-- ✅ APLICADO EM PRODUÇÃO em 2026-06-17 via MCP (migrations
--    `advisors_security_fixes` + `advisors_security_fixes_revoke_public`).
--    Este arquivo reflete exatamente o que foi aplicado. Par _rollback.sql incluído.

-- P0 — view profiles expunha auth.users ao anon (lint 0002_auth_users_exposed).
-- A view roda como SECURITY DEFINER DE PROPÓSITO: faz LEFT JOIN auth.users para
-- trazer o e-mail, e o invoker (anon/authenticated) não tem acesso a auth.users —
-- trocar para security_invoker QUEBRARIA a view. Fix seguro: remover o acesso do
-- papel anon (a view só é consultada por usuário logado, sempre via user.id).
-- (O lint 0010_security_definer_view permanece e é intencional aqui.)
revoke all on public.profiles from anon;

-- P0 — tabela de backup pública sem RLS (lint 0013_rls_disabled_in_public).
-- Sem policy, fica acessível só ao service_role/owner (objetivo de um backup).
-- Não é referenciada pelo app.
alter table public._backup_cobrasq_data_20260611 enable row level security;

-- P2 — funções com search_path mutável (lint 0011). DO block resolve as assinaturas
-- reais via catálogo (não quebra se a aridade divergir).
do $$
declare r record;
begin
  for r in
    select 'alter function public.' || quote_ident(p.proname)
           || '(' || pg_get_function_identity_arguments(p.oid) || ') set search_path = public, pg_temp' as stmt
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'fin_touch_atualizada_em','fin_saldos_realizados','fin_saldo_geral_bancario',
        'ag_messages_block_mutation','ag_touch_updated_at','ag_reset_daily_counter_if_stale',
        'safe_numeric','safe_date','fn_cobrasq_data_anti_shrink'
      )
  loop
    execute r.stmt;
  end loop;
end $$;

-- P2 — SECURITY DEFINER administrativas executáveis pelo anon (lint 0028). O EXECUTE
-- vinha herdado de PUBLIC, então revoga de PUBLIC e concede explicitamente a
-- authenticated/service_role (o app chama logado). Funções portal_* são
-- intencionalmente anônimas e NÃO são alteradas.
revoke execute on function public.arquivar_cliente(uuid, text) from public, anon;
grant  execute on function public.arquivar_cliente(uuid, text) to authenticated, service_role;
revoke execute on function public.reativar_cliente(uuid) from public, anon;
grant  execute on function public.reativar_cliente(uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- NÃO aplicado (dependem do modelo de tenancy / são toggles de painel):
--
-- P1 — políticas RLS USING(true) (lint 0024). Template — ajustar ao escopo real:
--   alter policy ag_conv_update_authenticated on public.ag_conversations
--     using (current_user_grupo() = grupo_id) with check (current_user_grupo() = grupo_id);
--   alter policy import_astrea_rw on public.import_astrea
--     using (current_user_papel() = 'proprietario') with check (current_user_papel() = 'proprietario');
--   (login_attempts_insert com WITH CHECK(true) costuma ser intencional.)
--
-- WARN — ativar "Leaked Password Protection" no painel Auth (sem SQL).
-- ─────────────────────────────────────────────────────────────────────────
