-- 20260628_tighten_atender_solicitacao_grant.sql
-- APLICADA EM PROD via MCP em 2026-06-28 (registro versionado / parity).
--
-- Defense-in-depth: public.atender_solicitacao_contato(uuid) é ação de STAFF (a própria
-- função já rejeita não-staff via current_user_papel()). Não precisa ser executável por
-- anon/PUBLIC e não é referenciada em nenhuma RLS policy → revogar é seguro.
-- Mantém EXECUTE para authenticated (o gestor chama logado pelo app). Idempotente.
REVOKE EXECUTE ON FUNCTION public.atender_solicitacao_contato(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.atender_solicitacao_contato(uuid) FROM anon;
