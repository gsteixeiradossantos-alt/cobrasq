-- ============================================================================
-- As duas views de análise da Bia voltam a respeitar a RLS
--
-- APLICADA EM PRODUÇÃO em 29/07/2026.
--
-- `vw_bia_respostas_humanas` e `vw_bia_metricas_semanal` eram as últimas
-- SECURITY DEFINER do schema (fora `profiles`, que é decisão antiga —
-- ver migração crm_revert_profiles_security_invoker). O `anon` já tinha saído
-- delas em 20260729_p0_views_revoke_anon.sql, então não vazavam para fora;
-- entre logados seguiam sem RLS.
--
-- A recomendação inicial foi DROPAR (nenhum consumidor no código, zero
-- dependências no banco). Optei pelo caminho não-destrutivo: ligar o invoker
-- resolve o mesmo problema e preserva as views, que servem para leitura manual
-- de métricas da operação da Bia no SQL editor.
--
-- VERIFICADO depois de aplicar, com o JWT do gestor: 359 respostas e 4 semanas
-- de métricas continuam visíveis — as views não viraram casca vazia.
--
-- ROLLBACK: alter view <nome> reset (security_invoker);
-- ============================================================================

alter view public.vw_bia_respostas_humanas set (security_invoker = true);
alter view public.vw_bia_metricas_semanal  set (security_invoker = true);
