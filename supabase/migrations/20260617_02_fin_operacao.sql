-- PR3: "operação única" recebimento↔repasse.
--
-- Problema: hoje o repasse ao credor era lançado como uma DESPESA manual separada
-- da RECEITA do recebimento; a despesa ficava "pendente/atrasada" mesmo sem a entrada
-- ter caído. Esta tabela amarra, por PARCELA PAGA: o recebimento do devedor, a fatia
-- de CAPITAL (a repassar ao credor) e a fatia de HONORÁRIO (lucro da Cobrasq), além
-- do estado do repasse (PIX) e da NFS-e. A despesa de repasse só "existe" depois que
-- o recebimento confirma — por construção, a operação nasce do pagamento.
--
-- Autossuficiente de propósito: o módulo fin_* veio do Controlle (fin_contato/fin_conta)
-- e é um mundo à parte do CRM (devedores/clientes). A ponte para fin_lancamento fica
-- nas colunas lancamento_*_id (nullable) para um passo futuro, sem acoplar agora.
--
-- Split: regra confirmada — credor recebe o CAPITAL (principal); o excedente é
-- honorário. Diluído proporcionalmente por parcela. A base de capital é capturada na
-- criação da operação (metadata) a partir do acordo/devedor.

create table if not exists public.fin_operacao (
  id uuid primary key default gen_random_uuid(),
  acordo_id   uuid references public.acordos(id)   on delete set null,
  devedor_id  uuid references public.devedores(id) on delete set null,
  credor_id   uuid references public.clientes(id)  on delete set null,

  -- Vínculo Asaas (idempotência por parcela paga).
  asaas_payment_id     text unique,
  asaas_installment_id text,
  parcela        integer,
  total_parcelas integer,

  -- Valores desta parcela.
  valor_recebido  numeric(14,2) not null default 0,
  valor_capital   numeric(14,2) not null default 0,  -- a repassar ao credor
  valor_honorario numeric(14,2) not null default 0,  -- lucro da Cobrasq
  recebido_em     date,

  recebimento_status text not null default 'recebido',   -- recebido
  -- pendente | preparado | efetuado | nao_aplica (quando não há capital a repassar)
  repasse_status     text not null default 'pendente',
  repasse_asaas_transfer_id text,
  repasse_comprovante_url   text,
  repasse_efetuado_em       timestamptz,
  -- pendente | emitida | nao_aplica
  nf_status text not null default 'pendente',
  nf_asaas_id text,
  nf_url      text,

  -- Ponte futura p/ o módulo financeiro (fin_lancamento.id é bigserial).
  lancamento_receita_id bigint,
  lancamento_despesa_id bigint,

  metadata jsonb not null default '{}'::jsonb,
  criada_em     timestamptz not null default now(),
  atualizada_em timestamptz not null default now()
);

create index if not exists idx_fin_operacao_acordo  on public.fin_operacao(acordo_id);
create index if not exists idx_fin_operacao_devedor on public.fin_operacao(devedor_id);
create index if not exists idx_fin_operacao_credor  on public.fin_operacao(credor_id);
create index if not exists idx_fin_operacao_repasse on public.fin_operacao(repasse_status);
create index if not exists idx_fin_operacao_installment on public.fin_operacao(asaas_installment_id);

-- updated_at automático (mesma função dos demais fin_*).
drop trigger if exists trg_fin_operacao_touch on public.fin_operacao;
create trigger trg_fin_operacao_touch
  before update on public.fin_operacao
  for each row execute function fin_touch_atualizada_em();

-- RLS: só proprietário (igual ao restante do módulo financeiro).
alter table public.fin_operacao enable row level security;
drop policy if exists fin_operacao_owner_all on public.fin_operacao;
create policy fin_operacao_owner_all on public.fin_operacao
  for all using (current_user_papel() = 'proprietario')
  with check (current_user_papel() = 'proprietario');

comment on table public.fin_operacao is
  'Operação única: por parcela paga, amarra recebimento (devedor) + repasse de capital '
  '(credor) + honorário (lucro) + estado de repasse PIX e NFS-e. Criada pelo '
  'recebimento confirmado (asaas-webhook → /api/processar-recebimento).';
