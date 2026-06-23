-- Rollback de 2026-06-23a_intimacoes_datajud.sql
-- Remove o índice/coluna de dedup e restaura o CHECK de `fonte` SEM 'datajud'.
-- ATENÇÃO: se já houver linhas com fonte='datajud', o ALTER do CHECK falhará —
--   apague-as antes (DELETE FROM public.proc_intimacoes WHERE fonte='datajud').

DROP INDEX IF EXISTS public.uq_intimacoes_dedup;
ALTER TABLE public.proc_intimacoes DROP COLUMN IF EXISTS dedup_key;

ALTER TABLE public.proc_intimacoes DROP CONSTRAINT IF EXISTS proc_intimacoes_fonte_check;
ALTER TABLE public.proc_intimacoes
  ADD CONSTRAINT proc_intimacoes_fonte_check
  CHECK (fonte IN ('escavador','jusbrasil','codilo','manual'));
