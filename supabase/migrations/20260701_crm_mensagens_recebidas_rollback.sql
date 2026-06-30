-- Rollback de 20260701_crm_mensagens_recebidas.sql
DROP VIEW IF EXISTS public.vw_conversas_pendentes;
DROP FUNCTION IF EXISTS public.resolver_caso_por_telefone(text);
DROP TABLE IF EXISTS public.crm_mensagens_recebidas;
