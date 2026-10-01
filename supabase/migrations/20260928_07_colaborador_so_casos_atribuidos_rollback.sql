-- Rollback de 20260928_07 — policies do colaborador como estavam em prod em 28/09/2026.
drop policy if exists cobrancas_colaborador_select on public.cobrancas;
drop policy if exists cobrancas_colaborador_insert on public.cobrancas;
drop policy if exists cobrancas_colaborador_update on public.cobrancas;
create policy cobrancas_colaborador_owned on public.cobrancas for all to public
  using ((current_user_papel() = 'colaborador') and ((cadastrado_por = auth.uid()) or (assigned_to = auth.uid())))
  with check ((current_user_papel() = 'colaborador') and ((cadastrado_por = auth.uid()) or (assigned_to = auth.uid())));

drop policy if exists devedores_colaborador_select on public.devedores;
drop policy if exists devedores_colaborador_insert on public.devedores;
drop policy if exists devedores_colaborador_update on public.devedores;
create policy devedores_colaborador_owned on public.devedores for all to public
  using ((current_user_papel() = 'colaborador') and ((cadastrado_por = auth.uid()) or (assigned_to = auth.uid())))
  with check ((current_user_papel() = 'colaborador') and ((cadastrado_por = auth.uid()) or (assigned_to = auth.uid())));
create policy devedores_colaborador_parte on public.devedores for select to authenticated
  using ((current_user_papel() = 'colaborador') and (id in (select p.devedor_id from cobranca_partes p
          join cobrancas c on c.id = p.cobranca_id
          where (c.cadastrado_por = auth.uid()) or (c.assigned_to = auth.uid()))));

drop policy if exists cobranca_partes_colaborador_owned on public.cobranca_partes;
create policy cobranca_partes_colaborador_owned on public.cobranca_partes for all to public
  using ((current_user_papel() = 'colaborador') and (cobranca_id in (select cobrancas.id from cobrancas
          where (cobrancas.cadastrado_por = auth.uid()) or (cobrancas.assigned_to = auth.uid()))))
  with check ((current_user_papel() = 'colaborador') and (cobranca_id in (select cobrancas.id from cobrancas
          where (cobrancas.cadastrado_por = auth.uid()) or (cobrancas.assigned_to = auth.uid()))));

drop policy if exists cobranca_terceiros_colaborador_owned on public.cobranca_terceiros;
create policy cobranca_terceiros_colaborador_owned on public.cobranca_terceiros for all to public
  using ((current_user_papel() = 'colaborador') and (cobranca_id in (select cobrancas.id from cobrancas
          where (cobrancas.cadastrado_por = auth.uid()) or (cobrancas.assigned_to = auth.uid()))))
  with check ((current_user_papel() = 'colaborador') and (cobranca_id in (select cobrancas.id from cobrancas
          where (cobrancas.cadastrado_por = auth.uid()) or (cobrancas.assigned_to = auth.uid()))));

drop policy if exists eventos_colaborador_select on public.devedor_eventos;
drop policy if exists eventos_colaborador_insert on public.devedor_eventos;
drop policy if exists eventos_colaborador_update on public.devedor_eventos;
create policy eventos_colaborador_owned on public.devedor_eventos for all to public
  using ((current_user_papel() = 'colaborador') and (devedor_id in (select devedores.id from devedores
          where (devedores.cadastrado_por = auth.uid()) or (devedores.assigned_to = auth.uid()))))
  with check ((current_user_papel() = 'colaborador') and (devedor_id in (select devedores.id from devedores
          where (devedores.cadastrado_por = auth.uid()) or (devedores.assigned_to = auth.uid()))));

drop policy if exists repasses_colaborador_select on public.repasses_cliente;
drop policy if exists repasses_colaborador_insert on public.repasses_cliente;
drop policy if exists repasses_colaborador_update on public.repasses_cliente;
create policy repasses_colaborador_owned on public.repasses_cliente for all to authenticated
  using ((current_user_papel() = 'colaborador') and exists (select 1 from cobrancas c
          where c.id = repasses_cliente.cobranca_id and ((c.assigned_to = auth.uid()) or (c.cadastrado_por = auth.uid()))))
  with check ((current_user_papel() = 'colaborador') and exists (select 1 from cobrancas c
          where c.id = repasses_cliente.cobranca_id and ((c.assigned_to = auth.uid()) or (c.cadastrado_por = auth.uid()))));

drop policy if exists acordos_proprietario_all on public.acordos;
drop policy if exists acordos_colaborador_select on public.acordos;
drop policy if exists acordos_colaborador_insert on public.acordos;
drop policy if exists acordos_colaborador_update on public.acordos;
create policy acordos_staff_all on public.acordos for all to authenticated
  using (current_user_papel() = any (array['proprietario','colaborador']))
  with check (current_user_papel() = any (array['proprietario','colaborador']));

drop trigger if exists trg_cobrancas_assigned_default on public.cobrancas;
drop trigger if exists trg_devedores_assigned_default on public.devedores;
drop function if exists public.fn_colaborador_assigned_default();
drop function if exists public.colab_cobranca_ok(uuid);
drop function if exists public.colab_devedor_parte_ok(uuid);
