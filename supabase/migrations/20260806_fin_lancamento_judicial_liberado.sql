-- Judicial (Sisbajud/Penhora) é EXPECTATIVA de bloqueio, não caixa realizado — pode
-- levar meses/anos até virar dinheiro de verdade na conta. Hoje esses lançamentos só
-- somem de Movimentações (ver PR #486), mas continuam contando como "entrada de caixa"
-- no KPI mensal da aba Caixa, o que infla o número. Pedido do Gustavo (2026-08-06):
-- separar "bloqueado/aguardando" de "já recebido de verdade", com um jeito de mover um
-- lançamento judicial de um estado pro outro quando o dinheiro realmente cai na conta.
--
-- judicial_liberado_em = quando o valor de um lançamento categorizado como Sisbajud/
-- Penhora efetivamente virou caixa (chegou numa conta). Enquanto NULL, o lançamento:
--   - aparece na aba Judicial (aguardando);
--   - fica de fora de Movimentações e do KPI mensal da aba Caixa (é só expectativa).
-- Uma vez preenchido (via a ação "Confirmar recebimento" na aba Judicial):
--   - some da aba Judicial;
--   - passa a aparecer normalmente em Movimentações e no KPI da Caixa, na data em que
--     foi de fato recebido (data_competencia/data_pagamento também são atualizadas para
--     essa data — mesma lógica do fix de "data de pagamento" para entradas normais).
-- A categoria (Sisbajud/Penhora) NÃO é removida — mantém o rastro de origem pra
-- relatório/auditoria; só o filtro de exibição muda com base nesta coluna.

alter table public.fin_lancamento
  add column if not exists judicial_liberado_em date;

comment on column public.fin_lancamento.judicial_liberado_em is
  'Para lançamentos categorizados Sisbajud/Penhora: data em que o valor efetivamente virou caixa. NULL = ainda é só expectativa de bloqueio (fica na aba Judicial, fora de Movimentações/KPI de Caixa).';
