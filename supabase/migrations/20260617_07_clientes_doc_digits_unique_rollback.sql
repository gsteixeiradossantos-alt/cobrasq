-- 20260617_07_clientes_doc_digits_unique_rollback.sql
-- Reverte 20260617_07: remove a trava de unicidade de CNPJ/CPF dos clientes.
DROP INDEX IF EXISTS public.idx_clientes_doc_digits_unique;
