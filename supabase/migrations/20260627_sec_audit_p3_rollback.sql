-- ROLLBACK de 20260627_sec_audit_p3.sql (volta SELECT para using(true))
begin;

drop policy if exists ag_actions_select_staff on public.ag_actions;
create policy ag_actions_select_authenticated on public.ag_actions
  for select to authenticated using (true);

drop policy if exists ag_conv_select_staff on public.ag_conversations;
create policy ag_conv_select_authenticated on public.ag_conversations
  for select to authenticated using (true);

commit;
