-- Rollback de 20260617_01_devedores_asaas_customer_id.sql

DROP INDEX IF EXISTS public.idx_devedores_asaas_customer_id;

ALTER TABLE public.devedores
  DROP COLUMN IF EXISTS asaas_customer_id;
