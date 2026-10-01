-- 20260928_09 — Colaborador: WhatsApp/intimações só dos casos atribuídos; exclusão e
-- cadastro de credor/grupo só do proprietário.
--
-- Defeito: as tabelas abaixo tinham policy "staff_all" (proprietario OU colaborador, ALL).
-- Com a 07 o colaborador passou a ver só os casos atribuídos, mas aqui ele continuava
-- lendo TODAS as conversas de WhatsApp (7455 recebidas, 6711 status, 668 atendimentos,
-- 1975 agendadas), todas as intimações, e podia apagar credor, grupo, documento de
-- credor e import do Astrea.
--
-- Decisões do Gustavo (28/09/2026):
--   • WhatsApp: colaborador vê só linha com caso_id de caso dele; linha sem caso = só dono.
--   • Só o dono exclui.
--   • Credor novo do colaborador vai por pedido de aprovação (F-22) — escrita em
--     clientes/grupos_economicos fica só do dono; leitura segue para a equipe.
--
-- Edge functions e webhooks gravam com service_role (ignoram RLS) — não são afetados.
-- Depende da 07 (colab_cobranca_ok / colab_devedor_parte_ok).

begin;

-- ── proc_intimacoes ─────────────────────────────────────────────────────────────
drop policy if exists intimacoes_staff_all on public.proc_intimacoes;
create policy intimacoes_proprietario_all on public.proc_intimacoes
  for all to authenticated
  using (public.current_user_papel() = 'proprietario')
  with check (public.current_user_papel() = 'proprietario');
create policy intimacoes_colab_select on public.proc_intimacoes
  for select to authenticated using (public.colab_devedor_parte_ok(devedor_id));
create policy intimacoes_colab_insert on public.proc_intimacoes
  for insert to authenticated with check (public.colab_devedor_parte_ok(devedor_id));
create policy intimacoes_colab_update on public.proc_intimacoes
  for update to authenticated
  using (public.colab_devedor_parte_ok(devedor_id))
  with check (public.colab_devedor_parte_ok(devedor_id));

-- ── WhatsApp: recebidas / status / enviadas / atendimentos ────────────────────────
drop policy if exists msg_recebida_staff_all on public.crm_mensagens_recebidas;
create policy msg_recebida_proprietario_all on public.crm_mensagens_recebidas
  for all to authenticated
  using (public.current_user_papel() = 'proprietario')
  with check (public.current_user_papel() = 'proprietario');
create policy msg_recebida_colab_select on public.crm_mensagens_recebidas
  for select to authenticated using (public.colab_cobranca_ok(caso_id));
create policy msg_recebida_colab_update on public.crm_mensagens_recebidas
  for update to authenticated
  using (public.colab_cobranca_ok(caso_id)) with check (public.colab_cobranca_ok(caso_id));

drop policy if exists msg_status_staff_all on public.crm_mensagens_status;
create policy msg_status_proprietario_all on public.crm_mensagens_status
  for all to authenticated
  using (public.current_user_papel() = 'proprietario')
  with check (public.current_user_papel() = 'proprietario');
create policy msg_status_colab_select on public.crm_mensagens_status
  for select to authenticated using (public.colab_cobranca_ok(caso_id));
create policy msg_status_colab_update on public.crm_mensagens_status
  for update to authenticated
  using (public.colab_cobranca_ok(caso_id)) with check (public.colab_cobranca_ok(caso_id));

drop policy if exists msg_enviada_staff_all on public.crm_mensagens_enviadas;
create policy msg_enviada_proprietario_all on public.crm_mensagens_enviadas
  for all to authenticated
  using (public.current_user_papel() = 'proprietario')
  with check (public.current_user_papel() = 'proprietario');
create policy msg_enviada_colab_select on public.crm_mensagens_enviadas
  for select to authenticated using (public.colab_cobranca_ok(caso_id));
create policy msg_enviada_colab_insert on public.crm_mensagens_enviadas
  for insert to authenticated with check (public.colab_cobranca_ok(caso_id));
create policy msg_enviada_colab_update on public.crm_mensagens_enviadas
  for update to authenticated
  using (public.colab_cobranca_ok(caso_id)) with check (public.colab_cobranca_ok(caso_id));

drop policy if exists bia_atend_staff_all on public.whatsapp_atendimentos;
create policy bia_atend_proprietario_all on public.whatsapp_atendimentos
  for all to authenticated
  using (public.current_user_papel() = 'proprietario')
  with check (public.current_user_papel() = 'proprietario');
create policy bia_atend_colab_select on public.whatsapp_atendimentos
  for select to authenticated using (public.colab_cobranca_ok(caso_id));
create policy bia_atend_colab_update on public.whatsapp_atendimentos
  for update to authenticated
  using (public.colab_cobranca_ok(caso_id)) with check (public.colab_cobranca_ok(caso_id));

-- ── crm_mensagens_agendadas (insert/delete do operador já existem e ficam) ─────────
drop policy if exists msg_agendada_select_staff on public.crm_mensagens_agendadas;
drop policy if exists msg_agendada_update_staff on public.crm_mensagens_agendadas;
create policy msg_agendada_select_escopo on public.crm_mensagens_agendadas
  for select using (
    public.current_user_papel() = 'proprietario'
    or public.colab_cobranca_ok(caso_id)
    or (public.current_user_papel() = 'colaborador' and operador_id = auth.uid()));
create policy msg_agendada_update_escopo on public.crm_mensagens_agendadas
  for update using (
    public.current_user_papel() = 'proprietario'
    or public.colab_cobranca_ok(caso_id)
    or (public.current_user_papel() = 'colaborador' and operador_id = auth.uid()));

-- ── clientes: leitura da equipe, escrita só do dono ───────────────────────────────
drop policy if exists clientes_staff_all on public.clientes;
create policy clientes_staff_select on public.clientes
  for select to authenticated
  using (public.current_user_papel() = any (array['proprietario','colaborador']));
create policy clientes_proprietario_write on public.clientes
  for all to authenticated
  using (public.current_user_papel() = 'proprietario')
  with check (public.current_user_papel() = 'proprietario');

-- ── grupos_economicos: leitura segue (read_authed), escrita só do dono ─────────────
drop policy if exists grupos_economicos_staff_write on public.grupos_economicos;
create policy grupos_economicos_proprietario_write on public.grupos_economicos
  for all to authenticated
  using (public.current_user_papel() = 'proprietario')
  with check (public.current_user_papel() = 'proprietario');

-- ── cliente_documentos: excluir só o dono ──────────────────────────────────────────
drop policy if exists clidoc_delete_staff on public.cliente_documentos;
create policy clidoc_delete_proprietario on public.cliente_documentos
  for delete using (public.current_user_papel() = 'proprietario');

-- ── import_astrea: equipe lê/grava, excluir só o dono ─────────────────────────────
drop policy if exists import_astrea_staff on public.import_astrea;
create policy import_astrea_proprietario_all on public.import_astrea
  for all to authenticated
  using (public.current_user_papel() = 'proprietario')
  with check (public.current_user_papel() = 'proprietario');
create policy import_astrea_colab_select on public.import_astrea
  for select to authenticated using (public.current_user_papel() = 'colaborador');
create policy import_astrea_colab_insert on public.import_astrea
  for insert to authenticated with check (public.current_user_papel() = 'colaborador');
create policy import_astrea_colab_update on public.import_astrea
  for update to authenticated
  using (public.current_user_papel() = 'colaborador')
  with check (public.current_user_papel() = 'colaborador');

commit;
