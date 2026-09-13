-- ============================================================================
-- ROLLBACK de 20260912_03_proc_intimacoes_fonte_email.sql
-- Apaga as linhas de fonte email/djen (senão o CHECK antigo não volta) e
-- restaura o CHECK anterior (2026-06-23a).
-- ============================================================================

begin;

DELETE FROM public.proc_intimacoes WHERE fonte IN ('email','djen');

ALTER TABLE public.proc_intimacoes DROP CONSTRAINT IF EXISTS proc_intimacoes_fonte_check;
ALTER TABLE public.proc_intimacoes
  ADD CONSTRAINT proc_intimacoes_fonte_check
  CHECK (fonte IN ('escavador','jusbrasil','codilo','datajud','manual'));

commit;
