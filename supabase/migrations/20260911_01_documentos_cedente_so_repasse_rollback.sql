-- Volta às policies de 20260630_01_cedente_rls_acesso.sql (cedente lê qualquer
-- documento das cobranças dele).
drop policy if exists documentos_cedente_scope on public.documentos;
create policy documentos_cedente_scope on public.documentos for select to authenticated
  using (cobranca_id in (select c.id::text from public.cobrancas c where c.cliente_id in (select id from public.clientes where app_user_id = auth.uid())));
drop policy if exists documentos_cedente_select on storage.objects;
create policy documentos_cedente_select on storage.objects for select to authenticated
  using (bucket_id = 'documentos' and exists (
    select 1 from public.documentos d join public.cobrancas c on c.id::text = d.cobranca_id
    join public.clientes cl on cl.id = c.cliente_id
    where d.storage_path = storage.objects.name and cl.app_user_id = auth.uid()));
