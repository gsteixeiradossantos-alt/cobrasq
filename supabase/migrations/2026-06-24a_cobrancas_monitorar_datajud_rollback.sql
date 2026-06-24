-- ============================================================================
-- ROLLBACK de 2026-06-24a_cobrancas_monitorar_datajud.sql
-- Remove a flag de monitoramento por processo. O cron volta a consultar toda
-- cobrança com numero_processo preenchido (reverter também o filtro em
-- api/cron-datajud.js).
-- ============================================================================

ALTER TABLE public.cobrancas
  DROP COLUMN IF EXISTS monitorar_datajud;
