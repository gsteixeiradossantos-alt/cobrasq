-- ============================================================
-- ROLLBACK de 20260706_infra_reaper_lock_agendadas.sql
-- ============================================================
-- Remove o índice e a coluna do reaper de lock. Seguro: a coluna é auxiliar
-- (não guarda dado de negócio). Antes de reverter, reverta também a FONTE da edge
-- function cron-mensagens-agendadas (que passa a gravar/ler processando_desde).

DROP INDEX IF EXISTS public.idx_crm_msg_agendadas_processando;

ALTER TABLE public.crm_mensagens_agendadas
  DROP COLUMN IF EXISTS processando_desde;
