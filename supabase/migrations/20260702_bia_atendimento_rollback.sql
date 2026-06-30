-- Rollback de 20260702_bia_atendimento.sql
DO $$ BEGIN
  PERFORM cron.unschedule('bia-atendimento') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='bia-atendimento');
EXCEPTION WHEN OTHERS THEN NULL; END $$;
DROP TABLE IF EXISTS public.whatsapp_bia_log;
DROP TABLE IF EXISTS public.whatsapp_atendimentos;
DROP TABLE IF EXISTS public.whatsapp_bia_config;
