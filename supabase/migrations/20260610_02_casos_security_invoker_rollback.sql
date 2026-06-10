-- ============================================================================
-- ROLLBACK F-04 — desfaz 20260610_02_casos_security_invoker.sql
-- ============================================================================
-- ⚠️ ATENÇÃO: voltar `casos` a security_invoker=false faz a view rodar como
--   DEFINER (dona = postgres), IGNORANDO a RLS de devedores/clientes →
--   REABRE o vazamento cross-tenant (todo colaborador vê TODOS os casos no CRM).
--   Use SOMENTE se pinar invoker=true quebrou um fluxo legítimo (ex.: gestor
--   parou de ver casos por causa de RLS mal configurada em devedores — nesse
--   caso o fix correto é F-05, não este rollback).
-- ============================================================================

ALTER VIEW public.casos SET (security_invoker = false);
