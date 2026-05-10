-- ============================================================
-- Aba Judicial: gestão de custódias judiciais
-- Aplicado em produção: 2026-05-10 via Supabase MCP
-- Migration: fin_custodia_judicial
-- ============================================================

create table fin_custodia_judicial (
  id bigserial primary key,
  descricao text not null,
  tipo int not null default 0,
  -- 0=Sisbajud, 1=Penhora salário, 2=Penhora rosto autos, 3=Acordo bloqueado, 4=Alvará pendente, 5=Outros
  status int not null default 0,
  -- 0=Aguardando bloqueio, 1=Bloqueado, 2=Aguardando alvará, 3=Alvará expedido, 4=Sacado, 5=Frustrado/arquivado
  valor_previsto numeric(14,2),
  valor_bloqueado numeric(14,2),
  valor_sacado numeric(14,2),
  data_solicitacao date,
  data_bloqueio date,
  data_alvara date,
  data_saque date,
  data_arquivamento date,
  processo_numero text,
  comarca text,
  vara text,
  devedor_id uuid references devedores(id) on delete set null,
  cliente_id uuid references clientes(id) on delete set null,
  conta_destino_id bigint references fin_conta(id) on delete set null,
  lancamento_id bigint references fin_lancamento(id) on delete set null,
  observacoes text,
  raw_payload jsonb,
  criada_em timestamptz default now(),
  atualizada_em timestamptz default now()
);

-- View de alertas
create or replace view fin_custodia_judicial_alertas as
select
  c.id, c.descricao, c.tipo, c.status,
  c.processo_numero, c.valor_previsto, c.valor_bloqueado,
  c.data_alvara, c.data_arquivamento,
  case
    when c.data_arquivamento is not null and c.status != 4
      then 'critico_arquivado_sem_saque'
    when c.status = 3 and c.data_alvara < (current_date - interval '30 days')
      then 'alvara_vencido_30d'
    when c.status = 2 and c.data_bloqueio < (current_date - interval '90 days')
      then 'aguardando_alvara_90d'
    when c.status = 0 and c.data_solicitacao < (current_date - interval '60 days')
      then 'aguardando_bloqueio_60d'
  end as alerta
from fin_custodia_judicial c
where (c.data_arquivamento is not null and c.status != 4)
   or (c.status = 3 and c.data_alvara < (current_date - interval '30 days'))
   or (c.status = 2 and c.data_bloqueio < (current_date - interval '90 days'))
   or (c.status = 0 and c.data_solicitacao < (current_date - interval '60 days'));

-- Migração: contatos do Controlle viraram clientes (executada 2026-05-10)
-- insert into clientes (nome, doc, email, telefone, metadata)
-- select nome, documento, email, telefone, jsonb_build_object('origem','fin_contato_controlle')
-- from fin_contato where ativo and lower(trim(nome)) not in (select lower(trim(nome)) from clientes);
