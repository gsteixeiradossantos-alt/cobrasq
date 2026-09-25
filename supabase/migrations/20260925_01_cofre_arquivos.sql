-- ═══════════════════════════════════════════════════════════════════════════
-- Cofre de arquivos do gestor (contratos, documentos da empresa, papéis avulsos)
--
-- POR QUE: não havia onde guardar contrato de cessão, contrato social, procuração
-- ou qualquer papel que não pertença a UM devedor. A tabela `public.documentos`
-- não serve: `devedor_doc` é NOT NULL, então todo arquivo lá é obrigatoriamente
-- de um devedor. Daí uma tabela própria + bucket próprio.
--
-- VISIBILIDADE (pedido do gestor 25/09/2026): gestor (papel `proprietario`) vê e
-- mexe em tudo; colaborador só vê o arquivo marcado `visivel_colaborador = true`,
-- e nunca envia, edita ou apaga. Cedente e devedor não têm acesso nenhum.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.cofre_arquivos (
  id                  uuid primary key default gen_random_uuid(),
  pasta               text not null default 'Geral',
  nome                text not null,
  storage_path        text not null unique,
  mime_type           text,
  size_bytes          bigint,
  obs                 text,
  visivel_colaborador boolean not null default false,
  ativo               boolean not null default true,
  uploaded_by         uuid,
  uploaded_at         timestamptz not null default now()
);

comment on table  public.cofre_arquivos is
  'Cofre do gestor: arquivos da empresa sem vínculo com devedor (contratos, societário, procurações).';
comment on column public.cofre_arquivos.pasta is
  'Pasta livre, digitada pelo gestor. Não há tabela de pastas: a pasta existe enquanto houver arquivo nela.';
comment on column public.cofre_arquivos.visivel_colaborador is
  'true = colaborador pode LER (nunca escrever). false = só o gestor vê.';
comment on column public.cofre_arquivos.ativo is
  'Exclusão é lógica: ativo=false some da tela e o objeto vai para _lixeira/ no bucket.';

create index if not exists cofre_arquivos_pasta_idx
  on public.cofre_arquivos (pasta) where ativo;
create index if not exists cofre_arquivos_uploaded_at_idx
  on public.cofre_arquivos (uploaded_at desc) where ativo;

-- ── RLS da tabela ─────────────────────────────────────────────────────────
alter table public.cofre_arquivos enable row level security;

drop policy if exists cofre_arquivos_select on public.cofre_arquivos;
create policy cofre_arquivos_select on public.cofre_arquivos
  for select using (
    public.current_user_papel() = 'proprietario'
    or (public.current_user_papel() = 'colaborador' and visivel_colaborador)
  );

drop policy if exists cofre_arquivos_insert on public.cofre_arquivos;
create policy cofre_arquivos_insert on public.cofre_arquivos
  for insert with check (public.current_user_papel() = 'proprietario');

drop policy if exists cofre_arquivos_update on public.cofre_arquivos;
create policy cofre_arquivos_update on public.cofre_arquivos
  for update using (public.current_user_papel() = 'proprietario')
          with check (public.current_user_papel() = 'proprietario');

drop policy if exists cofre_arquivos_delete on public.cofre_arquivos;
create policy cofre_arquivos_delete on public.cofre_arquivos
  for delete using (public.current_user_papel() = 'proprietario');

-- ── Bucket privado `cofre` ────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('cofre', 'cofre', false)
on conflict (id) do nothing;

-- Leitura: gestor tudo; colaborador só o objeto cujo metadado está liberado.
drop policy if exists cofre_storage_select on storage.objects;
create policy cofre_storage_select on storage.objects
  for select using (
    bucket_id = 'cofre'
    and (
      public.current_user_papel() = 'proprietario'
      or (
        public.current_user_papel() = 'colaborador'
        and exists (
          select 1 from public.cofre_arquivos a
          where a.storage_path = storage.objects.name
            and a.visivel_colaborador
            and a.ativo
        )
      )
    )
  );

-- Escrita (enviar, mover para _lixeira, apagar): só gestor.
drop policy if exists cofre_storage_insert on storage.objects;
create policy cofre_storage_insert on storage.objects
  for insert with check (
    bucket_id = 'cofre' and public.current_user_papel() = 'proprietario'
  );

drop policy if exists cofre_storage_update on storage.objects;
create policy cofre_storage_update on storage.objects
  for update using (
    bucket_id = 'cofre' and public.current_user_papel() = 'proprietario'
  ) with check (
    bucket_id = 'cofre' and public.current_user_papel() = 'proprietario'
  );

drop policy if exists cofre_storage_delete on storage.objects;
create policy cofre_storage_delete on storage.objects
  for delete using (
    bucket_id = 'cofre' and public.current_user_papel() = 'proprietario'
  );
