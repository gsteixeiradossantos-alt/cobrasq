-- ============================================================================
-- ROLLBACK F-03 — desfaz 20260610_01_fin_custodia_judicial_rls.sql
-- ============================================================================
-- Restaura o estado anterior (RLS desligada, sem policy) do arquivo
-- migrations/2026-05-09_fin_judicial.sql.
--
-- ATENÇÃO: este rollback REABRE o acesso a dados financeiros/judiciais para
--   qualquer autenticado via PostgREST. Use SOMENTE se o fix quebrou um fluxo
--   legítimo (ex.: colaborador precisa da aba Judicial) e ainda não há uma
--   policy melhor pronta. Casa de duas portas: o CRM não usa a tabela, então o
--   rollback não restaura nada no CRM.
-- ============================================================================

DROP POLICY IF EXISTS fin_custodia_judicial_owner_all ON public.fin_custodia_judicial;

ALTER TABLE public.fin_custodia_judicial DISABLE ROW LEVEL SECURITY;
