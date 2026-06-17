-- 20260617_03_advisors_security_fixes.sql
-- Correções de segurança apontadas pelos Supabase advisors (auditoria 2026-06).
-- Ver docs/AUDITORIA-2026-06.md (seção 1.1).
--
-- ⚠️ NÃO APLICADO AUTOMATICAMENTE. Revisar e aplicar via SQL Editor / MCP
--    (apply_migration) com confirmação. Há um par _rollback.sql.
--    Itens que dependem do modelo de tenancy (políticas USING(true)) ficam
--    COMENTADOS como template — não execute sem ajustar ao escopo real.

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- P0 — view public.profiles expõe auth.users ao anon E roda como SECURITY DEFINER
-- (lints 0002_auth_users_exposed + 0010_security_definer_view).
-- Faz a view respeitar a RLS de quem consulta e remove o acesso anônimo.
-- ─────────────────────────────────────────────────────────────────────────
alter view public.profiles set (security_invoker = true);
revoke select on public.profiles from anon;

-- ─────────────────────────────────────────────────────────────────────────
-- P0 — tabela de backup pública sem RLS (lint 0013_rls_disabled_in_public).
-- Sem policy, fica acessível só ao service_role (objetivo de um backup).
-- Recomendação: avaliar DROP quando o backup não for mais necessário.
-- ─────────────────────────────────────────────────────────────────────────
alter table public._backup_cobrasq_data_20260611 enable row level security;

-- ─────────────────────────────────────────────────────────────────────────
-- P2 — funções com search_path mutável (lint 0011_function_search_path_mutable).
-- Fixa search_path (mitiga sequestro de schema). DO block resolve as assinaturas
-- reais via catálogo, então não quebra se a aridade divergir.
-- ─────────────────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────────────────
-- P2 — SECURITY DEFINER de ação administrativa executáveis pelo anon
-- (lint 0028). Mantém para authenticated (o app chama logado), tira do anon.
-- As funções portal_* são intencionalmente anônimas (portal do devedor) e NÃO
-- são alteradas aqui.
-- ─────────────────────────────────────────────────────────────────────────
revoke execute on function public.arquivar_cliente(uuid, text) from anon;
revoke execute on function public.reativar_cliente(uuid) from anon;

-- ─────────────────────────────────────────────────────────────────────────
-- P1 — políticas RLS permissivas USING(true) (lint 0024). DEPENDEM do modelo de
-- tenancy real (grupo/papel). Template comentado — ajustar e aplicar à parte:
--
--   alter policy ag_conv_update_authenticated on public.ag_conversations
--     using (current_user_grupo() = grupo_id) with check (current_user_grupo() = grupo_id);
--   alter policy import_astrea_rw on public.import_astrea
--     using (current_user_papel() = 'proprietario') with check (current_user_papel() = 'proprietario');
--
-- NOTA: login_attempts_insert com WITH CHECK(true) é geralmente intencional
-- (anon precisa registrar tentativa de login) — avaliar antes de restringir.
-- ─────────────────────────────────────────────────────────────────────────

-- NOTA (não-SQL): ativar "Leaked Password Protection" no painel Auth
-- (lint auth_leaked_password_protection) — não há statement SQL para isso.

commit;
