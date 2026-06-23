-- Rollback de 2026-06-23b_peticionamentos.sql
DROP POLICY IF EXISTS peticionamentos_proprietario_all  ON public.proc_peticionamentos;
DROP POLICY IF EXISTS peticionamentos_colaborador_owned ON public.proc_peticionamentos;
DROP TABLE IF EXISTS public.proc_peticionamentos;
