-- Rollback de 20260629_assinaturas_avulsas.sql
DROP POLICY IF EXISTS assinaturas_avulsas_staff_all ON public.assinaturas_avulsas;
DROP TABLE IF EXISTS public.assinaturas_avulsas;
