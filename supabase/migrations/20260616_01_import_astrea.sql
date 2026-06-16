-- Migration: staging temporário para importação de processos/casos do Astrea.
-- Fluxo: o assistente (Claude) faz INSERT aqui a partir das exportações do Astrea;
-- a tela "Importação" (somente gestor) lê os pendentes e, no "Salvar" do usuário,
-- a própria sessão do app cria o devedor real no blob (cobrasq_data) via save().
-- Tabela isolada e descartável — não toca em devedores/clientes existentes.
-- Para remover depois: DROP TABLE public.import_astrea;

create table if not exists public.import_astrea (
  id uuid primary key default gen_random_uuid(),
  lote text,                                   -- rótulo do lote, ex.: 'Laercio Jubelli — 2026-06-16'
  origem text not null default 'Astrea',
  status text not null default 'pendente'
    check (status in ('pendente','importado','descartado')),
  payload jsonb not null,                      -- objeto já no formato do devedor (campos mapeados)
  faltantes text[] not null default '{}',      -- obrigatórios ausentes (ex.: doc, tel)
  created_at timestamptz not null default now(),
  created_by uuid
);

create index if not exists idx_import_astrea_pendente
  on public.import_astrea(status) where status = 'pendente';

alter table public.import_astrea enable row level security;

drop policy if exists import_astrea_rw on public.import_astrea;
create policy import_astrea_rw on public.import_astrea
  for all to authenticated using (true) with check (true);
