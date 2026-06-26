-- Rollback de 20260627_peticao_conversas_intake.sql.
ALTER TABLE public.peticao_conversas DROP COLUMN IF EXISTS intake;
