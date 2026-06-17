-- 20260617_03_advisors_security_fixes_rollback.sql
-- Reverte 20260617_03_advisors_security_fixes.sql.
-- ⚠️ Reverter RESTAURA a postura INSEGURA (anon lendo auth.users via profiles,
--    backup público, search_path solto) — usar só em emergência.

-- Restaura acesso do anon à view profiles (estado anterior, inseguro).
grant select on public.profiles to anon;

-- Desliga RLS do backup (estado anterior, inseguro).
alter table public._backup_cobrasq_data_20260611 disable row level security;

-- Remove o search_path fixado (volta a mutable).
do $$
declare r record;
begin
  for r in
    select 'alter function public.' || quote_ident(p.proname)
           || '(' || pg_get_function_identity_arguments(p.oid) || ') reset search_path' as stmt
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

-- Restaura execute do anon (via PUBLIC) nas funções administrativas.
grant execute on function public.arquivar_cliente(uuid, text) to public;
grant execute on function public.reativar_cliente(uuid) to public;
