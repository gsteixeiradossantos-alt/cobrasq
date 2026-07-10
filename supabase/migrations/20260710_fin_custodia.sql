-- Módulo "Custódias judiciais": dinheiro retido em juízo (SISBAJUD/depósito judicial),
-- FORA do caixa livre, até o alvará. Ciclo do valor:
--   bloqueado → depositado → alvara → levantado → rateado
-- No RATEIO, o valor levantado se divide: (−) custas, (−) honorários advocatícios,
-- (−) honorário COBRASQ, (=) repasse ao cedente — que cria uma fin_operacao pendente
-- (fin_operacao_id) e alimenta o módulo Repasses (A revisar).
--
-- Segue o padrão do restante do módulo financeiro: RLS só proprietário + trigger
-- fin_touch_atualizada_em. historico/rateio ficam em jsonb (livro do processo).

create table if not exists public.fin_custodia (
  id uuid primary key default gen_random_uuid(),

  processo_cnj text not null,               -- nº CNJ do processo
  vara         text,
  devedor_id   uuid references public.devedores(id) on delete set null,
  credor_id    uuid references public.clientes(id)  on delete set null,   -- cedente
  advogado     text,

  valor  numeric(14,2) not null default 0,  -- valor em custódia (retido)
  -- bloqueado | depositado | alvara | levantado | rateado
  status text not null default 'bloqueado',

  historico jsonb not null default '[]'::jsonb,   -- [{etapa,data,valor,conta}]
  rateio    jsonb,                                -- {levantado,custas,honorarios_adv[_pct],honorario_cobrasq[_pct],repasse_cedente}

  -- Vínculo com o repasse gerado no rateio (alimenta o módulo Repasses).
  fin_operacao_id uuid references public.fin_operacao(id) on delete set null,

  metadata jsonb not null default '{}'::jsonb,
  criada_em     timestamptz not null default now(),
  atualizada_em timestamptz not null default now()
);

create index if not exists idx_fin_custodia_status  on public.fin_custodia(status);
create index if not exists idx_fin_custodia_devedor on public.fin_custodia(devedor_id);
create index if not exists idx_fin_custodia_credor  on public.fin_custodia(credor_id);
create index if not exists idx_fin_custodia_operacao on public.fin_custodia(fin_operacao_id);

-- updated_at automático (mesma função dos demais fin_*).
drop trigger if exists trg_fin_custodia_touch on public.fin_custodia;
create trigger trg_fin_custodia_touch
  before update on public.fin_custodia
  for each row execute function fin_touch_atualizada_em();

-- RLS: só proprietário (igual ao restante do módulo financeiro).
alter table public.fin_custodia enable row level security;
drop policy if exists fin_custodia_owner_all on public.fin_custodia;
create policy fin_custodia_owner_all on public.fin_custodia
  for all using (current_user_papel() = 'proprietario')
  with check (current_user_papel() = 'proprietario');

comment on table public.fin_custodia is
  'Custódias judiciais: valor retido em juízo (bloqueado→depositado→alvara→levantado→'
  'rateado), fora do caixa livre. No rateio gera fin_operacao (repasse ao cedente).';
