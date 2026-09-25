-- ════════════════════════════════════════════════════════════════════════════
-- Cofre de documentos da empresa (contratos, papéis internos)
--
-- Por que: não havia onde guardar contrato/documento que não pertence a um
-- devedor. A tabela `public.documentos` exige `devedor_doc NOT NULL` — é o
-- arquivo DO CASO, não da empresa. Este cofre é paralelo e independente.
--
-- Regra de visibilidade (decisão do gestor, 25/09/2026):
--   • gestor (papel 'proprietario') vê e mexe em tudo;
--   • colaborador vê SOMENTE o que estiver com `visivel_colaborador = true`,
--     e apenas para leitura/download — não sobe, não edita, não apaga;
--   • cedente e devedor não enxergam nada deste cofre.
--
-- Organização: pastas livres, criadas na hora (campo texto `pasta`).
-- Campos do arquivo: nome + observação livre. Nada além disso.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Tabela de metadados ──────────────────────────────────────────────────
create table if not exists public.cofre_arquivos (
  id                   uuid primary key default gen_random_uuid(),
  pasta                text        not null default 'Geral',
  nome                 text        not null,
  storage_path         text        not null unique,
  mime_type            text,
  size_bytes           bigint,
  obs                  text,
  visivel_colaborador  boolean     not null default false,
  ativo                boolean     not null default true,
  uploaded_by          uuid        references public.app_users(id) on delete set null,
  uploaded_at          timestamptz not null default now()
);

comment on table  public.cofre_arquivos is
  'Cofre de documentos da empresa (contratos, papéis internos). Privado do gestor; um arquivo só chega ao colaborador se visivel_colaborador = true.';
comment on column public.cofre_arquivos.pasta is
  'Pasta livre, digitada pelo gestor no upload. Não há tabela de pastas: a pasta existe enquanto houver arquivo nela.';
comment on column public.cofre_arquivos.visivel_colaborador is
  'Chave que libera ESTE arquivo para leitura do colaborador. Default false — nasce privado.';
comment on column public.cofre_arquivos.ativo is
  'Exclusão é lógica: ativo=false some da tela e da RLS de leitura do colaborador.';

create index if not exists cofre_arquivos_pasta_idx
  on public.cofre_arquivos (pasta) where ativo;
create index if not exists cofre_arquivos_uploaded_at_idx
  on public.cofre_arquivos (uploaded_at desc) where ativo;

-- ── 2. RLS da tabela ────────────────────────────────────────────────────────
alter table public.cofre_arquivos enable row level security;

drop policy if exists cofre_arquivos_select on public.cofre_arquivos;
create policy cofre_arquivos_select on public.cofre_arquivos
  for select using (
    public.current_user_papel() = 'proprietario'
    or (
      public.current_user_papel() = 'colaborador'
      and visivel_colaborador
      and ativo
    )
  );

-- Escrita (insert/update/delete): só o gestor.
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

-- ── 3. Bucket privado ───────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('cofre', 'cofre', false)
on conflict (id) do nothing;

-- ── 4. RLS do storage ───────────────────────────────────────────────────────
-- Leitura do colaborador espelha a tabela: o objeto só abre se houver linha
-- ativa e liberada apontando para ele. Sem a linha, o arquivo não existe para
-- ninguém além do gestor (evita objeto órfão virar porta dos fundos).
drop policy if exists cofre_select on storage.objects;
create policy cofre_select on storage.objects
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

drop policy if exists cofre_insert on storage.objects;
create policy cofre_insert on storage.objects
  for insert with check (
    bucket_id = 'cofre' and public.current_user_papel() = 'proprietario'
  );

drop policy if exists cofre_update on storage.objects;
create policy cofre_update on storage.objects
  for update using (
    bucket_id = 'cofre' and public.current_user_papel() = 'proprietario'
  ) with check (
    bucket_id = 'cofre' and public.current_user_papel() = 'proprietario'
  );

drop policy if exists cofre_delete on storage.objects;
create policy cofre_delete on storage.objects
  for delete using (
    bucket_id = 'cofre' and public.current_user_papel() = 'proprietario'
  );
