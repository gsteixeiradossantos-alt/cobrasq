-- JÁ APLICADO EM PROD (versão 20260702023627). Snapshot reconstruído do catálogo em 2026-07-29. NÃO rodar db push.
-- ============================================================================
-- Endurecimento da trigger-function enforce_cliente_app_user_id (criada em
-- 20260701_cedente_app_user_id_trigger.sql): remove o EXECUTE dos roles de
-- cliente. Trigger-function não precisa de EXECUTE do chamador, e sem o grant
-- ninguém consegue invocá-la diretamente via RPC.
--
-- ACL atual em prod (pg_proc.proacl, 2026-07-29):
--   {postgres=X/postgres, service_role=X/postgres}
-- ou seja: PUBLIC/anon/authenticated SEM execute; postgres (dono) e
-- service_role COM execute.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.enforce_cliente_app_user_id() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_cliente_app_user_id() TO service_role;
