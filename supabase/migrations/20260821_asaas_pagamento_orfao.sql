-- 20260821_asaas_pagamento_orfao.sql
--
-- PROBLEMA
-- Quando um pagamento do Asaas chega e o sistema não consegue encaixá-lo, ele some.
-- Dois ramos de /api/_processar-recebimento.js terminam sem deixar registro consultável:
--
--   1. BOLETO sem parcela correspondente — não cria lançamento (decisão correta: criar
--      mascarava cadastro incompleto), mas o único vestígio era um console.warn. Foi o
--      que engoliu o pagamento de R$106,00 da Fatima Cordova em 17/08 por semanas.
--   2. Pagamento SEM DEVEDOR casado — vira lançamento sem vínculo ("Recebimento —
--      devedor"), então o dinheiro entra no caixa mas ninguém sabe de quem é. Medidos
--      11 casos entre 01/07 e 21/08, R$ 4.050,36, incluindo um de R$ 1.500,00.
--
-- Nos dois casos o dinheiro é real e a decisão é humana. O que faltava era o lugar
-- onde essa decisão fica pendente e VISÍVEL — em vez de um log que ninguém lê.
--
-- Esta tabela é essa fila. Alimenta a aba Financeiro › Conciliação › Asaas.
--
-- SEGURANÇA: aditiva, tabela nova, sem impacto em leitura existente. RLS no mesmo
-- padrão do módulo financeiro (fin_lancamento/fin_operacao): proprietário-only via
-- current_user_papel(). O service role (webhook) ignora RLS, como já faz hoje.

create table if not exists public.asaas_pagamento_orfao (
  id                bigserial primary key,
  asaas_payment_id  text not null,
  asaas_customer_id text,
  valor             numeric(12,2),
  due_date          date,
  payment_date      date,
  billing_type      text,
  -- 'sem_lancamento' (boleto pago sem parcela) | 'sem_devedor' (customer não casado)
  motivo            text not null,
  detalhe           text,
  devedor_id        uuid references public.devedores(id) on delete set null,
  lancamento_id     bigint,
  resolvido_em      timestamptz,
  resolvido_por     uuid,
  criado_em         timestamptz not null default now()
);

-- Um pagamento entra na fila UMA vez. O Asaas reenvia o webhook até receber 200, e sem
-- isto cada reenvio criaria uma linha nova na fila do gestor.
create unique index if not exists asaas_pagamento_orfao_payment_uidx
  on public.asaas_pagamento_orfao (asaas_payment_id);

-- A tela lista o que está pendente; o índice serve essa leitura.
create index if not exists asaas_pagamento_orfao_pendentes_idx
  on public.asaas_pagamento_orfao (criado_em desc)
  where resolvido_em is null;

comment on table public.asaas_pagamento_orfao is
  'Fila de pagamentos do Asaas que não encaixaram sozinhos: boleto sem parcela '
  'correspondente ou pagamento sem devedor casado. Alimenta Financeiro › Conciliação › '
  'Asaas. Criada em 21/08/2026 para substituir o console.warn que engolia pagamento.';

alter table public.asaas_pagamento_orfao enable row level security;

create policy asaas_pagamento_orfao_owner_all
  on public.asaas_pagamento_orfao
  for all
  to authenticated
  using (current_user_papel() = 'proprietario')
  with check (current_user_papel() = 'proprietario');

-- ROLLBACK
--   drop table if exists public.asaas_pagamento_orfao;
