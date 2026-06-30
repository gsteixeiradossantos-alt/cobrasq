-- Acesso do CEDENTE (cliente credor) — SELECT only, escopo via clientes.app_user_id = auth.uid()
-- Espelha devedores_cedente_scope / clientes_cedente_self. Aplicada em prod via apply_migration.
drop policy if exists cobrancas_cedente_scope on public.cobrancas;
create policy cobrancas_cedente_scope on public.cobrancas for select to authenticated
  using (cliente_id in (select id from public.clientes where app_user_id = auth.uid()));
drop policy if exists cobranca_partes_cedente_scope on public.cobranca_partes;
create policy cobranca_partes_cedente_scope on public.cobranca_partes for select to authenticated
  using (cobranca_id in (select c.id from public.cobrancas c where c.cliente_id in (select id from public.clientes where app_user_id = auth.uid())));
drop policy if exists repasses_cedente_scope on public.repasses_cliente;
create policy repasses_cedente_scope on public.repasses_cliente for select to authenticated
  using (cliente_id in (select id from public.clientes where app_user_id = auth.uid()));
drop policy if exists documentos_cedente_scope on public.documentos;
create policy documentos_cedente_scope on public.documentos for select to authenticated
  using (cobranca_id in (select c.id::text from public.cobrancas c where c.cliente_id in (select id from public.clientes where app_user_id = auth.uid())));
drop policy if exists documentos_cedente_select on storage.objects;
create policy documentos_cedente_select on storage.objects for select to authenticated
  using (bucket_id = 'documentos' and exists (
    select 1 from public.documentos d join public.cobrancas c on c.id::text = d.cobranca_id
    join public.clientes cl on cl.id = c.cliente_id
    where d.storage_path = storage.objects.name and cl.app_user_id = auth.uid()));
