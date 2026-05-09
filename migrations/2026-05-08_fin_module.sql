-- ============================================================
-- MÓDULO FINANCEIRO (substituirá o Controlle)
-- Aplicado em produção: 2026-05-09 via Supabase MCP
-- Migrations: fin_module_schema + fin_module_rls
-- ============================================================

-- ------------------------------------------------------------
-- DIMENSÕES
-- ------------------------------------------------------------

create table fin_conta (
  id bigserial primary key,
  controlle_id bigint unique,
  descricao text not null,
  banco_id bigint,
  banco_nome text,
  agencia text,
  numero text,
  tipo int not null default 0,
  default_conta boolean default false,
  ativa boolean not null default true,
  saldo_inicial numeric(14,2) default 0,
  observacoes text,
  raw_payload jsonb,
  criada_em timestamptz default now(),
  atualizada_em timestamptz default now()
);

create table fin_categoria (
  id bigserial primary key,
  controlle_id bigint unique,
  controlle_parent_id bigint,
  parent_id bigint references fin_categoria(id) on delete set null,
  descricao text not null,
  nivel int not null default 1,
  tipo_movimento int not null,
  classificacao text,
  natureza text,
  cor text,
  is_father boolean default false,
  ativa boolean not null default true,
  raw_payload jsonb,
  criada_em timestamptz default now(),
  atualizada_em timestamptz default now()
);
create index on fin_categoria (parent_id);
create index on fin_categoria (tipo_movimento);
create index on fin_categoria (controlle_id);

create table fin_contato (
  id bigserial primary key,
  controlle_id bigint unique,
  nome text not null,
  documento text,
  email text,
  telefone text,
  ativo boolean not null default true,
  raw_payload jsonb,
  criada_em timestamptz default now(),
  atualizada_em timestamptz default now()
);
create index on fin_contato (documento);
create index on fin_contato (controlle_id);

create table fin_centro_custo (
  id bigserial primary key,
  controlle_id bigint unique,
  controlle_parent_id bigint,
  parent_id bigint references fin_centro_custo(id) on delete set null,
  descricao text not null,
  ativo boolean not null default true,
  raw_payload jsonb,
  criada_em timestamptz default now(),
  atualizada_em timestamptz default now()
);
create index on fin_centro_custo (parent_id);
create index on fin_centro_custo (controlle_id);

-- ------------------------------------------------------------
-- TEMPLATES (recorrência fixa)
-- ------------------------------------------------------------

create table fin_recorrencia_template (
  id bigserial primary key,
  controlle_id bigint unique,
  descricao text not null,
  valor numeric(14,2),
  tipo_movimento int,
  conta_id bigint references fin_conta(id),
  contato_id bigint references fin_contato(id),
  ativa boolean not null default true,
  data_inicio date,
  data_fim date,
  raw_payload jsonb,
  criada_em timestamptz default now(),
  atualizada_em timestamptz default now()
);

-- ------------------------------------------------------------
-- FATO: lançamentos
-- ------------------------------------------------------------

create table fin_lancamento (
  id bigserial primary key,
  controlle_payment_id bigint unique,
  controlle_transaction_id bigint,
  controlle_recurrence_id bigint,
  uuid text,
  descricao text not null,
  data_competencia date,
  data_vencimento date,
  data_pagamento date,
  valor numeric(14,2) not null,
  valor_pago numeric(14,2),
  juros numeric(14,2),
  multa numeric(14,2),
  desconto numeric(14,2),
  tipo_movimento int not null,
  status int not null default 0,
  conta_id bigint references fin_conta(id) on delete restrict,
  contato_id bigint references fin_contato(id) on delete set null,
  numero_parcela int,
  total_parcelas int,
  recorrencia_template_id bigint references fin_recorrencia_template(id) on delete set null,
  recorrencia_fixa boolean default false,
  conciliado boolean default false,
  tem_rateio boolean default false,
  is_pagamento_parcial boolean default false,
  observacoes text,
  raw_payload jsonb,
  criada_em timestamptz default now(),
  atualizada_em timestamptz default now()
);
create index on fin_lancamento (data_competencia desc);
create index on fin_lancamento (data_vencimento) where status = 0;
create index on fin_lancamento (data_pagamento desc);
create index on fin_lancamento (status);
create index on fin_lancamento (conta_id);
create index on fin_lancamento (contato_id);
create index on fin_lancamento (controlle_transaction_id);
create index on fin_lancamento (controlle_recurrence_id);

-- ------------------------------------------------------------
-- RATEIOS
-- ------------------------------------------------------------

create table fin_lancamento_categoria (
  id bigserial primary key,
  lancamento_id bigint not null references fin_lancamento(id) on delete cascade,
  categoria_id bigint references fin_categoria(id) on delete set null,
  controlle_apportionment_id bigint,
  controlle_categoria_id bigint,
  valor numeric(14,2) not null default 0,
  criada_em timestamptz default now()
);
create index on fin_lancamento_categoria (lancamento_id);
create index on fin_lancamento_categoria (categoria_id);

create table fin_lancamento_centro_custo (
  id bigserial primary key,
  lancamento_id bigint not null references fin_lancamento(id) on delete cascade,
  centro_custo_id bigint references fin_centro_custo(id) on delete set null,
  controlle_apportionment_id bigint,
  controlle_centro_custo_id bigint,
  valor numeric(14,2) not null default 0,
  criada_em timestamptz default now()
);
create index on fin_lancamento_centro_custo (lancamento_id);
create index on fin_lancamento_centro_custo (centro_custo_id);

-- ------------------------------------------------------------
-- AUDIT
-- ------------------------------------------------------------

create table fin_sync_log (
  id bigserial primary key,
  iniciado_em timestamptz default now(),
  finalizado_em timestamptz,
  ok boolean,
  totais jsonb,
  erros jsonb,
  notas text
);

-- ------------------------------------------------------------
-- TRIGGER de updated_at
-- ------------------------------------------------------------

create or replace function fin_touch_atualizada_em() returns trigger as $$
begin
  new.atualizada_em = now();
  return new;
end; $$ language plpgsql;

create trigger trg_fin_conta_touch          before update on fin_conta          for each row execute function fin_touch_atualizada_em();
create trigger trg_fin_categoria_touch      before update on fin_categoria      for each row execute function fin_touch_atualizada_em();
create trigger trg_fin_contato_touch        before update on fin_contato        for each row execute function fin_touch_atualizada_em();
create trigger trg_fin_centro_custo_touch   before update on fin_centro_custo   for each row execute function fin_touch_atualizada_em();
create trigger trg_fin_recorrencia_touch    before update on fin_recorrencia_template for each row execute function fin_touch_atualizada_em();
create trigger trg_fin_lancamento_touch     before update on fin_lancamento     for each row execute function fin_touch_atualizada_em();

-- ------------------------------------------------------------
-- RLS: somente proprietario acessa módulo financeiro
-- ------------------------------------------------------------

alter table fin_conta enable row level security;
alter table fin_categoria enable row level security;
alter table fin_contato enable row level security;
alter table fin_centro_custo enable row level security;
alter table fin_recorrencia_template enable row level security;
alter table fin_lancamento enable row level security;
alter table fin_lancamento_categoria enable row level security;
alter table fin_lancamento_centro_custo enable row level security;
alter table fin_sync_log enable row level security;

create policy fin_conta_owner_all                  on fin_conta                  for all using (current_user_papel() = 'proprietario') with check (current_user_papel() = 'proprietario');
create policy fin_categoria_owner_all              on fin_categoria              for all using (current_user_papel() = 'proprietario') with check (current_user_papel() = 'proprietario');
create policy fin_contato_owner_all                on fin_contato                for all using (current_user_papel() = 'proprietario') with check (current_user_papel() = 'proprietario');
create policy fin_centro_custo_owner_all           on fin_centro_custo           for all using (current_user_papel() = 'proprietario') with check (current_user_papel() = 'proprietario');
create policy fin_recorrencia_template_owner_all   on fin_recorrencia_template   for all using (current_user_papel() = 'proprietario') with check (current_user_papel() = 'proprietario');
create policy fin_lancamento_owner_all             on fin_lancamento             for all using (current_user_papel() = 'proprietario') with check (current_user_papel() = 'proprietario');
create policy fin_lancamento_categoria_owner_all   on fin_lancamento_categoria   for all using (current_user_papel() = 'proprietario') with check (current_user_papel() = 'proprietario');
create policy fin_lancamento_centro_custo_owner_all on fin_lancamento_centro_custo for all using (current_user_papel() = 'proprietario') with check (current_user_papel() = 'proprietario');
create policy fin_sync_log_owner_all               on fin_sync_log               for all using (current_user_papel() = 'proprietario') with check (current_user_papel() = 'proprietario');
