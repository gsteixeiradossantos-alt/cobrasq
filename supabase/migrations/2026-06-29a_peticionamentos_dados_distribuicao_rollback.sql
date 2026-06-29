-- ============================================================================
-- ROLLBACK de 2026-06-29a_peticionamentos_dados_distribuicao.sql
-- Remove o snapshot da distribuição inicial. Reverter também o uso no app
-- (index.html: submeterPeticionamento) e no endpoint api/_eproc-peticionamento.js.
-- ============================================================================

ALTER TABLE public.proc_peticionamentos
  DROP COLUMN IF EXISTS dados_distribuicao;
