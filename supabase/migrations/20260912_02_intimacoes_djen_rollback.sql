-- ============================================================================
-- ROLLBACK de 20260912_02_intimacoes_djen.sql
-- Remove cron, view, função de cruzamento, tabela e índice. O backfill de
-- `intimacoes_email.tribunal` NÃO é desfeito (era NULL por bug; o valor novo
-- está certo e é o que o worker passa a gravar). `cnj_tribunal` sai por último.
-- ============================================================================

begin;

DO $$
BEGIN
  PERFORM cron.unschedule('djen-intimacoes');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DROP VIEW IF EXISTS public.vw_intimacoes_so_diario;
DROP FUNCTION IF EXISTS public.intimacoes_djen_cruzar(int);
DROP INDEX IF EXISTS public.uq_dev_eventos_djen_dedup;
DROP TABLE IF EXISTS public.intimacoes_djen;
DROP FUNCTION IF EXISTS public.cnj_tribunal(text);

commit;
