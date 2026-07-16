-- Rollback de 2026-07-02_email_intimacoes.sql
DO $$ BEGIN
  PERFORM cron.unschedule('email-intimacoes') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='email-intimacoes');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DROP INDEX IF EXISTS public.uq_dev_eventos_email_dedup;
DROP VIEW IF EXISTS public.vw_intimacoes_a_vincular;
DROP TABLE IF EXISTS public.email_msgs_processadas;
DROP TABLE IF EXISTS public.intimacoes_email;
