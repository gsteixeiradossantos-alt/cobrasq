-- Auditoria de sobrescrita em public.clientes: antes de qualquer UPDATE feito pela tela
-- (salvarCliente), o app grava aqui uma cópia do registro como estava. Não impede o erro,
-- mas torna reversível em segundos qualquer perda de dado de cadastro por sobrescrita.
create table if not exists public.clientes_historico (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null,
  snapshot jsonb not null,
  alterado_por text,
  alterado_em timestamptz not null default now()
);

create index if not exists idx_clientes_historico_cliente_id
  on public.clientes_historico(cliente_id, alterado_em desc);

alter table public.clientes_historico enable row level security;

create policy "clientes_historico_staff_all" on public.clientes_historico
  for all
  using (current_user_papel() = any (array['proprietario'::text, 'colaborador'::text]))
  with check (current_user_papel() = any (array['proprietario'::text, 'colaborador'::text]));
