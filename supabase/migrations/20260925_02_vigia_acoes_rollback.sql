-- Rollback de 20260925_02_vigia_acoes.sql (apaga os achados).
begin;
DO $$ BEGIN
  PERFORM cron.unschedule('vigia-acoes') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='vigia-acoes');
EXCEPTION WHEN OTHERS THEN NULL; END $$;
DROP VIEW  IF EXISTS public.vw_vigia_acoes_universo;
DROP TABLE IF EXISTS public.vigia_acoes_busca;
DROP TABLE IF EXISTS public.vigia_acoes;
commit;
