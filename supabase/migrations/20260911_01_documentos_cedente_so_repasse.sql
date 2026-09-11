-- Cedente só enxerga documentos de REPASSE (comprovante PIX ao cliente).
--
-- Antes (20260630_01_cedente_rls_acesso.sql) as duas policies liberavam ao cedente
-- QUALQUER linha de `documentos` ligada a uma cobrança dele — contrato, acordo
-- assinado, petição, cálculo — e o arquivo correspondente no bucket. O portal do
-- cedente não listava nada disso (o card "Documentos" é placeholder), mas a
-- permissão estava aberta na API. Decisão do Gustavo em 11/09/2026: o cliente vê
-- apenas o que for repasse/comprovante do PIX.
--
-- Regra: categoria = 'repasse' OU documento referenciado por um repasse do cliente
-- (`repasses_cliente.documento_id`) — este segundo ramo cobre comprovante gravado
-- com outra categoria, desde que esteja de fato pendurado num repasse dele.
-- Continua SELECT only; a escrita nunca foi liberada ao cedente.

drop policy if exists documentos_cedente_scope on public.documentos;
create policy documentos_cedente_scope on public.documentos for select to authenticated
  using (
    cobranca_id in (
      select c.id::text from public.cobrancas c
      where c.cliente_id in (select id from public.clientes where app_user_id = auth.uid()))
    and (
      categoria = 'repasse'
      or id in (
        select r.documento_id from public.repasses_cliente r
        where r.documento_id is not null
          and r.cliente_id in (select id from public.clientes where app_user_id = auth.uid()))
    )
  );

drop policy if exists documentos_cedente_select on storage.objects;
create policy documentos_cedente_select on storage.objects for select to authenticated
  using (bucket_id = 'documentos' and exists (
    select 1 from public.documentos d
    join public.cobrancas c on c.id::text = d.cobranca_id
    join public.clientes cl on cl.id = c.cliente_id
    where d.storage_path = storage.objects.name
      and cl.app_user_id = auth.uid()
      and (
        d.categoria = 'repasse'
        or d.id in (
          select r.documento_id from public.repasses_cliente r
          where r.documento_id is not null and r.cliente_id = cl.id)
      )));
