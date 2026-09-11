-- ============================================================================
-- ROLLBACK de 20260910_04_resumo_diario_agenda.sql
-- Remove o cron e a função. Mensagens 'resumo_diario' já enfileiradas ficam
-- na fila (o worker as envia ou já enviou); apagar não é necessário.
-- ============================================================================

begin;

DO $$
BEGIN
  PERFORM cron.unschedule('resumo-diario-agenda');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DROP FUNCTION IF EXISTS public.resumo_diario_agenda(boolean, date);

commit;
