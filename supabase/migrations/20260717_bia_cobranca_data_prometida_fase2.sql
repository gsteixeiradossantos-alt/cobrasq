-- JÁ APLICADO EM PROD (versão 20260717223107). Snapshot reconstruído do catálogo em 2026-07-29. NÃO rodar db push.
-- ============================================================================
-- Bia Cobrança · Fase 2: data que o devedor PROMETEU pagar (para cobrar a
-- promessa e contar promessas_quebradas).
-- ============================================================================

ALTER TABLE public.bia_cobranca
  ADD COLUMN IF NOT EXISTS data_prometida date;
