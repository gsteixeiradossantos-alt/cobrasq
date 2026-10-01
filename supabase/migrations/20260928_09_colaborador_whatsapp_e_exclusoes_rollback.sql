-- Rollback da 20260928_09 — recria as policies "staff" exatamente como estavam em prod
-- (lidas de pg_policies em 01/10/2026).
begin;

drop policy if exists intimacoes_proprietario_all on public.proc_intimacoes;
drop policy if exists intimacoes_colab_select on public.proc_intimacoes;
drop policy if exists intimacoes_colab_insert on public.proc_intimacoes;
drop policy if exists intimacoes_colab_update on public.proc_intimacoes;
create policy intimacoes_staff_all on public.proc_intimacoes for all to authenticated
  using (current_user_papel() = any (array['proprietario','colaborador']))
  with check (current_user_papel() = any (array['proprietario','colaborador']));

drop policy if exists msg_recebida_proprietario_all on public.crm_mensagens_recebidas;
drop policy if exists msg_recebida_colab_select on public.crm_mensagens_recebidas;
drop policy if exists msg_recebida_colab_update on public.crm_mensagens_recebidas;
create policy msg_recebida_staff_all on public.crm_mensagens_recebidas for all
  using (current_user_papel() = any (array['proprietario','colaborador']))
  with check (current_user_papel() = any (array['proprietario','colaborador']));

drop policy if exists msg_status_proprietario_all on public.crm_mensagens_status;
drop policy if exists msg_status_colab_select on public.crm_mensagens_status;
drop policy if exists msg_status_colab_update on public.crm_mensagens_status;
create policy msg_status_staff_all on public.crm_mensagens_status for all
  using (current_user_papel() = any (array['proprietario','colaborador']))
  with check (current_user_papel() = any (array['proprietario','colaborador']));

drop policy if exists msg_enviada_proprietario_all on public.crm_mensagens_enviadas;
drop policy if exists msg_enviada_colab_select on public.crm_mensagens_enviadas;
drop policy if exists msg_enviada_colab_insert on public.crm_mensagens_enviadas;
drop policy if exists msg_enviada_colab_update on public.crm_mensagens_enviadas;
create policy msg_enviada_staff_all on public.crm_mensagens_enviadas for all
  using (current_user_papel() = any (array['proprietario','colaborador']))
  with check (current_user_papel() = any (array['proprietario','colaborador']));

drop policy if exists bia_atend_proprietario_all on public.whatsapp_atendimentos;
drop policy if exists bia_atend_colab_select on public.whatsapp_atendimentos;
drop policy if exists bia_atend_colab_update on public.whatsapp_atendimentos;
create policy bia_atend_staff_all on public.whatsapp_atendimentos for all
  using (current_user_papel() = any (array['proprietario','colaborador']))
  with check (current_user_papel() = any (array['proprietario','colaborador']));

drop policy if exists msg_agendada_select_escopo on public.crm_mensagens_agendadas;
drop policy if exists msg_agendada_update_escopo on public.crm_mensagens_agendadas;
create policy msg_agendada_select_staff on public.crm_mensagens_agendadas for select
  using (current_user_papel() = any (array['proprietario','colaborador']));
create policy msg_agendada_update_staff on public.crm_mensagens_agendadas for update
  using (current_user_papel() = any (array['proprietario','colaborador']));

drop policy if exists clientes_staff_select on public.clientes;
drop policy if exists clientes_proprietario_write on public.clientes;
create policy clientes_staff_all on public.clientes for all to authenticated
  using (current_user_papel() = any (array['proprietario','colaborador']))
  with check (current_user_papel() = any (array['proprietario','colaborador']));

drop policy if exists grupos_economicos_proprietario_write on public.grupos_economicos;
create policy grupos_economicos_staff_write on public.grupos_economicos for all to authenticated
  using (current_user_papel() = any (array['proprietario','colaborador']))
  with check (current_user_papel() = any (array['proprietario','colaborador']));

drop policy if exists clidoc_delete_proprietario on public.cliente_documentos;
create policy clidoc_delete_staff on public.cliente_documentos for delete
  using (current_user_papel() = any (array['proprietario','colaborador']));

drop policy if exists import_astrea_proprietario_all on public.import_astrea;
drop policy if exists import_astrea_colab_select on public.import_astrea;
drop policy if exists import_astrea_colab_insert on public.import_astrea;
drop policy if exists import_astrea_colab_update on public.import_astrea;
create policy import_astrea_staff on public.import_astrea for all to authenticated
  using (current_user_papel() = any (array['proprietario','colaborador']))
  with check (current_user_papel() = any (array['proprietario','colaborador']));

commit;
