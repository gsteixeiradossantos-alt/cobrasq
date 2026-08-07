-- Reformulação do Financeiro: modelo de repasse em cascata.
-- Um recebimento com parte de cedente passa a ser UM lançamento com divisão
-- calculada (capital / meu_total / amortizado), em vez de dois lançamentos
-- espelhados (entrada + saída) editados manualmente a cada atraso.
-- Ver design_handoff_financeiro/README.md para o motor de cálculo (divide()).
--
-- NÃO aplicar em produção sem autorização explícita (ver CLAUDE.md do repo).

-- ── fin_lancamento: colunas da cascata ──────────────────────────────────
-- Só descritas na payload que o app grava; o sync do Controlle
-- (scripts/import_controlle.py) faz upsert só com as colunas espelhadas do
-- Controlle, então não sobrescreve estas.
alter table public.fin_lancamento
  add column if not exists capital numeric,
  add column if not exists meu_total numeric,
  add column if not exists amortizado numeric not null default 0,
  add column if not exists cedente_id uuid references public.clientes(id),
  add column if not exists repasse_status text;

alter table public.fin_lancamento
  drop constraint if exists fin_lancamento_repasse_status_check;
alter table public.fin_lancamento
  add constraint fin_lancamento_repasse_status_check
  check (repasse_status is null or repasse_status in ('aguardando','pendente','atrasado','pago'));

create index if not exists idx_fin_lancamento_cedente_pendente
  on public.fin_lancamento (cedente_id, repasse_status)
  where cedente_id is not null;

comment on column public.fin_lancamento.capital is 'Valor de face do título — pertence ao cedente.';
comment on column public.fin_lancamento.meu_total is 'Excedente sobre o capital (juros/multa/correção/honorários) — pertence à COBRASQ.';
comment on column public.fin_lancamento.amortizado is 'Quanto o devedor já havia pago neste título antes deste recebimento.';
comment on column public.fin_lancamento.repasse_status is 'aguardando (sem cedente ainda) | pendente | atrasado | pago.';

-- ── fin_contrato_cedente: regra de divisão por cliente ──────────────────
create table if not exists public.fin_contrato_cedente (
  cliente_id        uuid primary key references public.clientes(id) on delete cascade,
  modo              text not null default 'cascata' check (modo in ('cascata','percentual')),
  pct               numeric,
  descontar_custas  boolean not null default false,
  prazo_dias        int not null default 5,
  pix_chave         text,
  forma_envio       text check (forma_envio is null or forma_envio in ('pix_auto_asaas','pix_manual','ted_btg')),
  criado_em         timestamptz not null default now(),
  atualizado_em     timestamptz not null default now()
);

alter table public.fin_contrato_cedente enable row level security;
drop policy if exists fin_contrato_cedente_owner_all on public.fin_contrato_cedente;
create policy fin_contrato_cedente_owner_all on public.fin_contrato_cedente
  for all using (current_user_papel() = 'proprietario') with check (current_user_papel() = 'proprietario');

-- ── fin_repasse_plano / fin_repasse_parcela: repasse programado ─────────
create table if not exists public.fin_repasse_plano (
  id           uuid primary key default gen_random_uuid(),
  cliente_id   uuid not null references public.clientes(id) on delete cascade,
  valor_total  numeric not null,
  intervalo    text not null check (intervalo in ('semanal','quinzenal','mensal')),
  primeira_em  date not null,
  criado_em    timestamptz not null default now()
);

create table if not exists public.fin_repasse_parcela (
  id                uuid primary key default gen_random_uuid(),
  plano_id          uuid not null references public.fin_repasse_plano(id) on delete cascade,
  numero            int not null,
  vence_em          date not null,
  valor             numeric not null,
  pago_em           timestamptz,
  comprovante_path  text,
  unique (plano_id, numero)
);

create index if not exists idx_fin_repasse_parcela_plano on public.fin_repasse_parcela (plano_id);

alter table public.fin_repasse_plano enable row level security;
alter table public.fin_repasse_parcela enable row level security;
drop policy if exists fin_repasse_plano_owner_all on public.fin_repasse_plano;
create policy fin_repasse_plano_owner_all on public.fin_repasse_plano
  for all using (current_user_papel() = 'proprietario') with check (current_user_papel() = 'proprietario');
drop policy if exists fin_repasse_parcela_owner_all on public.fin_repasse_parcela;
create policy fin_repasse_parcela_owner_all on public.fin_repasse_parcela
  for all using (current_user_papel() = 'proprietario') with check (current_user_papel() = 'proprietario');
