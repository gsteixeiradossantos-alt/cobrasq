-- Desfaz 20261005_03: tira o agendamento, as funções e a tabela de controle do rodízio.
-- Os andamentos já gravados (proc_intimacoes / devedor_eventos) ficam.
DO $$ BEGIN
  PERFORM cron.unschedule('datajud-andamentos') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='datajud-andamentos');
END $$;
DROP FUNCTION IF EXISTS public.datajud_registrar_eventos(jsonb);
DROP FUNCTION IF EXISTS public.datajud_proximos(integer);
DROP TABLE IF EXISTS public.datajud_controle;
