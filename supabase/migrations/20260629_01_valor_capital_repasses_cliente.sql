-- Capital da dívida + repasses ao cliente
-- Aplicada em prod via apply_migration em 2026-06-29.

-- Valor capital da dívida (sem juros/multa/correção)
alter table public.cobrancas add column if not exists valor_capital numeric(14,2);

-- Repasses ao cliente (1 linha por comprovante de repasse PIX COBRASQ -> credor)
create table if not exists public.repasses_cliente (
  id uuid primary key default gen_random_uuid(),
  cobranca_id uuid not null references public.cobrancas(id) on delete cascade,
  cliente_id  uuid references public.clientes(id) on delete set null,
  valor numeric(14,2) not null,
  data_pix date,
  transacao_id text,
  destinatario_nome text,
  destinatario_doc text,
  documento_id uuid references public.documentos(id) on delete set null,
  status text not null default 'confirmado',
  origem text default 'ia',          -- 'ia' | 'manual'
  created_by uuid,
  created_at timestamptz default now()
);
create unique index if not exists uq_repasse_cobr_transacao
  on public.repasses_cliente(cobranca_id, transacao_id) where transacao_id is not null;
create index if not exists idx_repasse_cobranca on public.repasses_cliente(cobranca_id);

alter table public.repasses_cliente enable row level security;

drop policy if exists repasses_proprietario_all on public.repasses_cliente;
create policy repasses_proprietario_all on public.repasses_cliente
  for all to authenticated
  using (current_user_papel() = 'proprietario')
  with check (current_user_papel() = 'proprietario');

drop policy if exists repasses_colaborador_owned on public.repasses_cliente;
create policy repasses_colaborador_owned on public.repasses_cliente
  for all to authenticated
  using (
    current_user_papel() = 'colaborador'
    and exists (select 1 from public.cobrancas c where c.id = cobranca_id
                and (c.assigned_to = auth.uid() or c.cadastrado_por = auth.uid()))
  )
  with check (
    current_user_papel() = 'colaborador'
    and exists (select 1 from public.cobrancas c where c.id = cobranca_id
                and (c.assigned_to = auth.uid() or c.cadastrado_por = auth.uid()))
  );
