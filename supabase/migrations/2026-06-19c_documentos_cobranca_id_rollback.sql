-- ROLLBACK de 2026-06-19c_documentos_cobranca_id.sql
DROP INDEX IF EXISTS public.idx_documentos_cobranca;
ALTER TABLE public.documentos DROP COLUMN IF EXISTS cobranca_id;
