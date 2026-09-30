-- JÁ APLICADO EM PROD (versão 20260720124818). Snapshot reconstruído do catálogo em 2026-07-29. NÃO rodar db push.
-- ============================================================================
-- Bia Cobrança: flag "sem acréscimo" no pedido de aprovação — o proprietário
-- pode aprovar o novo prazo dispensando os acréscimos.
-- ============================================================================

ALTER TABLE public.bia_aprovacoes
  ADD COLUMN IF NOT EXISTS sem_acrescimo boolean NOT NULL DEFAULT false;
