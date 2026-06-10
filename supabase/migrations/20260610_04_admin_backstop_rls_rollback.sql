-- ============================================================================
-- ROLLBACK F-11 — desfaz 20260610_04_admin_backstop_rls.sql
-- ============================================================================
-- ⚠️ ATENÇÃO: desligar a RLS reaberta REEXPÕE a tabela a qualquer autenticado
--   via PostgREST. Use só se o backstop quebrou um fluxo legítimo.
--
-- Descomente APENAS os pares correspondentes às tabelas que VOCÊ fechou na
-- migration (mesma lista de F-11.a usada no apply).
--
-- ECOSSISTEMA: Supabase jokbxzhcctcwnbhkhgru (faturamento + CRM).
-- ============================================================================

/*  >>> DESCOMENTE por tabela revertida <<<

-- Exemplo A
DROP POLICY IF EXISTS user_integrations_staff_all ON public.user_integrations;
ALTER TABLE public.user_integrations DISABLE ROW LEVEL SECURITY;

-- Exemplo B
DROP POLICY IF EXISTS calendar_events_sync_owner_all ON public.calendar_events_sync;
ALTER TABLE public.calendar_events_sync DISABLE ROW LEVEL SECURITY;

-- ... um par por tabela revertida ...

    >>> FIM <<<  */
