-- ROLLBACK de 20260626_sec_audit_p1.sql (reverte ao estado anterior).
-- Atenção: re-grant das backups e ALL using(true) reabrem permissões — só usar se necessário.
begin;

-- profiles: volta sem o guard de staff
create or replace view public.profiles as
  select u.id,
         au.email::text as email,
         u.nome,
         case u.papel
           when 'proprietario' then 'admin'
           when 'colaborador'  then 'operador'
           else u.papel
         end as role,
         u.ativo,
         u.created_at,
         u.avatar_url,
         u.avatar_cor
  from app_users u
  left join auth.users au on au.id = u.id
  where u.papel = any (array['proprietario','colaborador']);

-- import_astrea: volta ao ALL using(true)
drop policy if exists import_astrea_staff on public.import_astrea;
create policy import_astrea_rw on public.import_astrea
  for all to authenticated using (true) with check (true);

-- ag_actions / ag_conversations: volta ao UPDATE using(true)
drop policy if exists ag_actions_update_staff on public.ag_actions;
create policy ag_actions_update_authenticated on public.ag_actions
  for update to authenticated using (true)
  with check (status = any (array['pending_dispatch','approved','rejected','cancelled']::ag_action_status[]));

drop policy if exists ag_conv_update_staff on public.ag_conversations;
create policy ag_conv_update_authenticated on public.ag_conversations
  for update to authenticated using (true) with check (true);

-- re-grant execute do anon
grant execute on function public.current_user_grupo_economico()      to anon;
grant execute on function public.fn_default_cadastrado_por()         to anon;
grant execute on function public.fn_sync_app_user_to_auth_metadata() to anon;
grant execute on function public.limpar_portal_tokens_vencidos()     to anon;

-- search_path: solta de novo
alter function public.preserve_asaas_customer_id() reset search_path;

-- backups: re-grant (RLS continua bloqueando leitura)
grant all on public._backup_cobrasq_data_20260611    to anon, authenticated;
grant all on public._backup_devedores_divida_20260623 to anon, authenticated;

commit;
