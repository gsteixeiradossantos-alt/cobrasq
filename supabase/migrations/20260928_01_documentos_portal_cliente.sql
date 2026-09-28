-- 20260928_01 — Documentos no portal do cliente (cedente)
--
-- Pedido da Bidão (28/09/2026): o cliente quer ver no portal os documentos do caso.
-- Até aqui o cedente só enxergava documentos de repasse (policies
-- documentos_cedente_scope/_grupo) e o botão "Enviar documento" do portal era
-- placeholder.
--
-- Regra decidida pelo Gustavo:
--   * O cliente vê só o que a equipe compartilhou (visivel_cliente = true), além dos
--     repasses (que as policies antigas já liberam) e do que ele mesmo enviou.
--   * O que o cliente envia pelo portal fica PENDENTE até a equipe aprovar
--     (status_aprovacao), com aviso no Painel.
--   * Documento que o cliente mandou por WhatsApp e a equipe cadastra entra como
--     origem 'cliente', já aprovado e visível.
--
-- Aditiva: não remove nenhuma policy. Rollback em _rollback.sql.

alter table public.documentos
  add column if not exists visivel_cliente  boolean not null default false,
  add column if not exists origem           text    not null default 'equipe',
  add column if not exists status_aprovacao text,
  add column if not exists aprovado_por     uuid references auth.users(id),
  add column if not exists aprovado_em      timestamptz;

do $$ begin
  alter table public.documentos add constraint documentos_origem_check
    check (origem in ('equipe','cliente'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.documentos add constraint documentos_status_aprovacao_check
    check (status_aprovacao is null or status_aprovacao in ('pendente','aprovado','recusado'));
exception when duplicate_object then null; end $$;

comment on column public.documentos.visivel_cliente is
  'Compartilhado com o cliente (cedente) no portal. Repasse já é visível pelas policies antigas, independente desta flag.';
comment on column public.documentos.origem is
  'equipe = anexado pela COBRASQ; cliente = enviado pelo cliente (portal ou WhatsApp cadastrado pela equipe).';
comment on column public.documentos.status_aprovacao is
  'Só para origem=cliente: pendente (enviado pelo portal, aguardando a equipe), aprovado, recusado.';

create index if not exists documentos_pendentes_cliente_idx
  on public.documentos (uploaded_at desc)
  where origem = 'cliente' and status_aprovacao = 'pendente' and ativo;

-- O caso (cobrança) é do cedente logado? Cobre os três vínculos em uso:
-- clientes.app_user_id, app_users.ref_id → clientes.id, e grupo (econômico ou de filiais).
create or replace function public.cedente_pode_cobranca(p_cobranca_id text)
returns boolean
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1
      from public.app_users au
      join public.cobrancas c on c.id::text = p_cobranca_id
      join public.clientes cl on cl.id = c.cliente_id
     where au.id = auth.uid()
       and au.papel = 'cedente'
       and coalesce(au.ativo, true)
       and ( cl.app_user_id = auth.uid()
          or (au.ref_id ~ '^[0-9a-fA-F-]{36}$' and cl.id = au.ref_id::uuid)
          or (au.pode_ver_grupo and (
                (au.grupo_economico_id is not null and cl.grupo_economico_id = au.grupo_economico_id)
             or (au.cliente_grupo_id  is not null and (cl.cliente_grupo_id = au.cliente_grupo_id or cl.id = au.cliente_grupo_id))
             )) )
  );
$$;
revoke all on function public.cedente_pode_cobranca(text) from public, anon;
grant execute on function public.cedente_pode_cobranca(text) to authenticated;

-- Linhas: compartilhados pela equipe + os que o próprio cliente enviou.
drop policy if exists documentos_cedente_portal on public.documentos;
create policy documentos_cedente_portal on public.documentos
  for select to authenticated
  using ( ativo
      and (visivel_cliente or origem = 'cliente')
      and public.cedente_pode_cobranca(cobranca_id) );

-- Arquivos: mesmo critério, resolvido pela linha de documentos.
drop policy if exists documentos_cedente_portal_select on storage.objects;
create policy documentos_cedente_portal_select on storage.objects
  for select to authenticated
  using ( bucket_id = 'documentos'
      and exists ( select 1 from public.documentos d
                    where d.storage_path = objects.name
                      and d.ativo
                      and (d.visivel_cliente or d.origem = 'cliente')
                      and public.cedente_pode_cobranca(d.cobranca_id) ) );

-- Upload do cliente: só em cobrancas/<id-do-caso-dele>/cliente/<arquivo> (R-24: a
-- policy lê o path, então o prefixo é contrato com quem grava).
drop policy if exists documentos_cedente_portal_insert on storage.objects;
create policy documentos_cedente_portal_insert on storage.objects
  for insert to authenticated
  with check ( bucket_id = 'documentos'
           and (storage.foldername(name))[1] = 'cobrancas'
           and (storage.foldername(name))[3] = 'cliente'
           and public.current_user_papel() = 'cedente'
           and public.cedente_pode_cobranca((storage.foldername(name))[2]) );

-- Registro da linha pelo cliente. A tabela não tem INSERT para cedente (doc_insert
-- exige pode_ver_devedor); a RPC valida o caso, o path e o arquivo e grava pendente.
create or replace function public.cedente_registrar_documento(
  p_cobranca_id text, p_nome text, p_storage_path text,
  p_mime text default null, p_size integer default null, p_categoria text default 'outros'
) returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_dev_id text; v_dev_doc text; v_id uuid;
  v_cat text := coalesce(nullif(p_categoria,''), 'outros');
begin
  if public.current_user_papel() is distinct from 'cedente' then
    raise exception 'apenas o cliente registra por aqui';
  end if;
  if not public.cedente_pode_cobranca(p_cobranca_id) then
    raise exception 'caso não pertence a este cliente';
  end if;
  if p_storage_path not like 'cobrancas/' || p_cobranca_id || '/cliente/%' then
    raise exception 'caminho de arquivo inválido';
  end if;
  if v_cat not in ('contrato','nota-promissoria','comprovante','outros') then
    v_cat := 'outros';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'documentos' and o.name = p_storage_path) then
    raise exception 'arquivo não encontrado no armazenamento';
  end if;

  select d.id::text,
         coalesce(nullif(regexp_replace(coalesce(d.doc_digits, d.doc, ''), '\D', '', 'g'), ''), 'id-' || d.id::text)
    into v_dev_id, v_dev_doc
    from public.cobranca_partes cp
    join public.devedores d on d.id = cp.devedor_id
   where cp.cobranca_id::text = p_cobranca_id
   order by cp.principal desc nulls last
   limit 1;

  insert into public.documentos
    (devedor_doc, devedor_id, cobranca_id, categoria, nome, storage_path, mime_type, size_bytes,
     uploaded_by, origem, status_aprovacao, visivel_cliente)
  values
    (coalesce(v_dev_doc, 'cob-' || p_cobranca_id), v_dev_id, p_cobranca_id, v_cat,
     left(coalesce(nullif(p_nome,''), 'documento'), 200), p_storage_path, p_mime, p_size,
     auth.uid(), 'cliente', 'pendente', true)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.cedente_registrar_documento(text,text,text,text,integer,text) from public, anon;
grant execute on function public.cedente_registrar_documento(text,text,text,text,integer,text) to authenticated;
