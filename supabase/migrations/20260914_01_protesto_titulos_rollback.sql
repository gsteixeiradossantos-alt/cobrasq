-- Rollback de 20260914_01_protesto_titulos.sql
begin;
DROP POLICY IF EXISTS protesto_owner_write ON public.protesto_titulos;
DROP POLICY IF EXISTS protesto_staff_select ON public.protesto_titulos;
DROP TABLE IF EXISTS public.protesto_titulos;
commit;
