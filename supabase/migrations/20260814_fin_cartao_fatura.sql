-- 20260814_fin_cartao_fatura.sql — fatura de cartão de crédito
--
-- Contexto: a tela Financeiro › Cadastros › Cartões existe desde antes, mas é
-- maquete: lê `DB.cartoes` (vazio em produção, zero cartões), a "fatura atual" é
-- um número digitado e o gráfico de barras é fixo no código. Nunca foi usada.
--
-- A conciliação contra o Controlle (14/08/2026) trouxe a fatura do cartão Sicredi
-- como uma despesa solta de R$ 3.752,91, com os meses seguintes PROJETADOS em
-- R$ 477,42 e depois R$ 391,33 — chute, não valor real. Decisão do proprietário:
-- um cartão só (Sicredi), lançado COMPRA A COMPRA, para a fatura ser a soma das
-- compras em vez de um número digitado.
--
-- Modelo contábil (evita contagem dupla, que é o erro clássico aqui):
--   • a COMPRA é despesa, lançada na conta do cartão, com fatura_id preenchido;
--   • a FATURA não é despesa — é o agrupador. O total dela é a soma das compras;
--   • o PAGAMENTO da fatura é transferência da conta bancária para a do cartão,
--     em fin_transferencia. Quem forma resultado são as compras; quem forma caixa
--     é o pagamento. Lançar a fatura TAMBÉM como despesa contaria o gasto 2x.
--
-- O cartão em si não ganha tabela nova: é registro em fin_conta com tipo = 2,
-- como o Nubank (id 3) já é hoje.

create table if not exists public.fin_fatura (
  id                       bigserial primary key,
  conta_id                 bigint  not null references public.fin_conta(id),
  competencia              date    not null,   -- 1º dia do mês de referência
  data_fechamento          date    not null,
  data_vencimento          date    not null,
  status                   smallint not null default 0,  -- 0 aberta · 1 fechada · 2 paga
  transferencia_id         bigint  references public.fin_transferencia(id),
  observacoes              text,
  criada_em                timestamptz default now(),
  atualizada_em            timestamptz default now(),
  constraint fin_fatura_status_ck check (status in (0,1,2)),
  constraint fin_fatura_datas_ck  check (data_vencimento >= data_fechamento),
  constraint fin_fatura_conta_competencia_uk unique (conta_id, competencia)
);

comment on table  public.fin_fatura is
  'Fatura de cartão de crédito. O valor NÃO fica aqui: é a soma dos fin_lancamento com este fatura_id. Guardar total seria coluna derivada sem trigger — o mesmo defeito da regressão R-17.';
comment on column public.fin_fatura.competencia is
  'Primeiro dia do mês de referência da fatura. Com data_fechamento define em qual fatura cai cada compra.';
comment on column public.fin_fatura.transferencia_id is
  'Pagamento da fatura: transferência da conta bancária para a conta do cartão. NULL enquanto não paga.';

alter table public.fin_lancamento
  add column if not exists fatura_id bigint references public.fin_fatura(id);

comment on column public.fin_lancamento.fatura_id is
  'Compra de cartão: aponta para a fatura que a agrupa. NULL em todo lançamento que não é compra de cartão.';

create index if not exists fin_lancamento_fatura_idx
  on public.fin_lancamento (fatura_id) where fatura_id is not null;

create index if not exists fin_fatura_conta_idx
  on public.fin_fatura (conta_id, competencia desc);

-- RLS no mesmo padrão de fin_conta/fin_lancamento: só o proprietário.
alter table public.fin_fatura enable row level security;

drop policy if exists fin_fatura_owner_all on public.fin_fatura;
create policy fin_fatura_owner_all on public.fin_fatura
  for all
  using      (current_user_papel() = 'proprietario')
  with check (current_user_papel() = 'proprietario');
