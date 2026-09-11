-- Dois buracos achados na vistoria do #695 (11/09/2026), ambos anteriores a ele:
--
-- A. Colaborador não anexa nem baixa em "Documentos do caso". As policies do bucket
--    (`documentos_insert`/`documentos_select`) avaliam pode_ver_devedor(foldername[2]);
--    no path `cobrancas/<id-da-cobrança>/<cat>/arquivo` o 2º segmento é o id da
--    cobrança SEM o prefixo `id-`, então nunca casa — só o proprietário passa. Medido:
--    o colaborador 38c7e348 vê 7 linhas de `documentos` em `cobrancas/…` e 0 objetos.
--    Conserto: policies ADITIVAS para paths `cobrancas/%`, resolvidas pela RLS da
--    própria `cobrancas` (colaborador = assigned_to/cadastrado_por), restritas a
--    staff — o cedente também lê `cobrancas`, e sem essa trava ele voltaria a
--    alcançar contrato/acordo pelo bucket, desfazendo a 20260911_01.
--
-- B. Cedente de grupo econômico vê o botão "comprovante" nos repasses dos clientes
--    irmãos (`repasses_cedente_grupo`, 20260710) mas `documentos` nunca ganhou a
--    variante `_grupo` → 16 botões em erro para o cedente 7f8382e4. Conserto:
--    `documentos_cedente_grupo` + storage, espelhando o predicado de grupo de
--    repasses e mantendo a regra de hoje (só repasse / comprovante de repasse).

-- ── A · staff em paths cobrancas/<cobranca_id>/… ─────────────────────────────
drop policy if exists documentos_cobranca_staff_insert on storage.objects;
create policy documentos_cobranca_staff_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'documentos'
    and (storage.foldername(name))[1] = 'cobrancas'
    and public.current_user_papel() in ('proprietario','colaborador')
    and exists (select 1 from public.cobrancas c where c.id::text = (storage.foldername(name))[2])
  );

drop policy if exists documentos_cobranca_staff_select on storage.objects;
create policy documentos_cobranca_staff_select on storage.objects for select to authenticated
  using (
    bucket_id = 'documentos'
    and (storage.foldername(name))[1] = 'cobrancas'
    and public.current_user_papel() in ('proprietario','colaborador')
    and exists (select 1 from public.cobrancas c where c.id::text = (storage.foldername(name))[2])
  );

-- ── B · cedente de grupo: só repasse, como na 20260911_01 ────────────────────
drop policy if exists documentos_cedente_grupo on public.documentos;
create policy documentos_cedente_grupo on public.documentos for select to authenticated
  using (
    (
      categoria = 'repasse'
      and cobranca_id in (
        select c.id::text from public.cobrancas c
        where c.cliente_id in (
          select cl.id from public.clientes cl
          where (public.current_user_grupo_economico() is not null and cl.grupo_economico_id = public.current_user_grupo_economico())
             or (public.current_user_grupo() is not null and (cl.cliente_grupo_id = public.current_user_grupo() or cl.id = public.current_user_grupo()))))
    )
    or id in (
      select r.documento_id from public.repasses_cliente r
      where r.documento_id is not null
        and r.cliente_id in (
          select cl.id from public.clientes cl
          where (public.current_user_grupo_economico() is not null and cl.grupo_economico_id = public.current_user_grupo_economico())
             or (public.current_user_grupo() is not null and (cl.cliente_grupo_id = public.current_user_grupo() or cl.id = public.current_user_grupo()))))
  );

drop policy if exists documentos_cedente_grupo_select on storage.objects;
create policy documentos_cedente_grupo_select on storage.objects for select to authenticated
  using (bucket_id = 'documentos' and exists (
    select 1 from public.documentos d
    join public.cobrancas c on c.id::text = d.cobranca_id
    join public.clientes cl on cl.id = c.cliente_id
    where d.storage_path = storage.objects.name
      and ((public.current_user_grupo_economico() is not null and cl.grupo_economico_id = public.current_user_grupo_economico())
        or (public.current_user_grupo() is not null and (cl.cliente_grupo_id = public.current_user_grupo() or cl.id = public.current_user_grupo())))
      and (d.categoria = 'repasse'
        or d.id in (select r.documento_id from public.repasses_cliente r where r.documento_id is not null and r.cliente_id = cl.id))));
