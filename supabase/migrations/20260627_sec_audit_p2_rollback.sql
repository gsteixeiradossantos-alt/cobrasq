-- ROLLBACK de 20260627_sec_audit_p2.sql
begin;

-- volta o SELECT do blob para using(true)
drop policy if exists data_read_staff on public.cobrasq_data;
create policy data_read_all_authed on public.cobrasq_data
  for select to authenticated using (true);

-- re-concede EXECUTE público (padrão) das 3 funções
grant execute on function public.fn_default_cadastrado_por()         to public;
grant execute on function public.fn_sync_app_user_to_auth_metadata() to public;
grant execute on function public.limpar_portal_tokens_vencidos()     to public;

commit;
