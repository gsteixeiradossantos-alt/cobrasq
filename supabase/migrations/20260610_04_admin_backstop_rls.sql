-- ============================================================================
-- F-11 — RLS de retaguarda em tabelas admin-only sem backstop
-- ============================================================================
-- ACHADO CORRIGIDO (F-11, P1): o RBAC é só no front (faturamento
--   ADMIN_ONLY_PAGES ~4529-4534; CRM renderAdmin/alternarRole). Esconder a UI
--   NÃO protege a tabela: quem abrir DevTools/PostgREST com a anon key lê/grava
--   direto se a tabela não tiver RLS de retaguarda. Precisamos garantir RLS +
--   policy em TODA tabela sensível admin-only.
--
-- ASSUNÇÃO SOBRE O PROD (estado explícito): schema aplicado via Supabase MCP;
--   os arquivos PODEM NÃO refletir o prod. >>> VERIFICAR ANTES via
--   supabase/verification/lote0_verify.sql, blocos F-11.a (RLS+policies por
--   tabela) e F-11.b (grants a anon/authenticated). <<<
--   A LISTA de tabelas a fechar SAI de F-11.a (rls_enabled=false OU sem policy).
--   O bloco abaixo é um TEMPLATE com as candidatas mais prováveis da matriz do
--   plano; >>> aplique SOMENTE as linhas correspondentes às tabelas que F-11.a
--   mostrou desprotegidas, e CONFIRME que cada uma existe. <<< Tabelas já
--   cobertas por outras migrations NÃO entram aqui:
--     • fin_* (proprietario-only) — 2026-05-08_fin_module.sql.
--     • fin_custodia_judicial — F-03 (20260610_01).
--     • pedidos_aprovacao — 20260609_pedidos_aprovacao.sql.
--     • regua_envios — 20260511_03_fase_C_regua_e_calendar.sql.
--     • proc_intimacoes — 20260511_01_intimacoes_rls.sql.
--     • app_users — docs/supabase-security.sql.
--   Depende de F-05: o backstop usa current_user_papel() (= app_users); se a
--   identidade ainda não estiver unificada, quem só está em profiles é negado.
--
-- APPS / n8n QUE LEEM/ESCREVEM (matriz do plano): varia por tabela —
--   • user_integrations / calendar_events_sync: faturamento (config de
--     integrações por usuário; criado em 20260510_07_user_integrations.sql).
--   • crm_* / peticao_*: CRM (+ Edge functions).
--   Como cada uma serve a um app, fechar com backstop de staff/owner não deve
--   afetar o outro app — MAS confirme na matriz antes de aplicar cada linha.
--
-- RISCO: MÉDIO (depende de F-03/F-05; toca authz que pode pegar os dois apps).
--   Mitigação: aplicar tabela-a-tabela, testando por papel. Reversível.
--
-- ROLLBACK: supabase/migrations/20260610_04_admin_backstop_rls_rollback.sql
--   (DROP POLICY + DISABLE ROW LEVEL SECURITY por tabela aplicada).
-- ----------------------------------------------------------------------------
-- ECOSSISTEMA: Supabase jokbxzhcctcwnbhkhgru — compartilhado por
--   cobrasq-faturamento + crm-cobrasq. Aplicar só após aprovação item-a-item.
-- ============================================================================


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ TEMPLATE — repita o par (ENABLE RLS + CREATE POLICY) por tabela que F-11.a   ║
-- ║ mostrou DESPROTEGIDA. Escolha o predicado de papel adequado à tabela:        ║
-- ║   • proprietario-only  → current_user_papel() = 'proprietario'               ║
-- ║   • staff (gestor+colab) → current_user_papel() IN ('proprietario','colaborador') ║
-- ║ Habilitar RLS SEM criar policy NEGA tudo a authenticated — só faça isso de   ║
-- ║ propósito (lockdown). O normal é ENABLE + uma policy de staff/owner.         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

/*  >>> DESCOMENTE/AJUSTE por tabela, conforme F-11.a <<<

-- Exemplo A — tabela de config por usuário (faturamento): só staff.
ALTER TABLE public.user_integrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_integrations_staff_all ON public.user_integrations;
CREATE POLICY user_integrations_staff_all ON public.user_integrations
  FOR ALL TO authenticated
  USING      (public.current_user_papel() IN ('proprietario','colaborador'))
  WITH CHECK (public.current_user_papel() IN ('proprietario','colaborador'));
-- (Se a tabela tiver dono por linha — ex.: user_id —, prefira escopo por dono:
--   USING (user_id = auth.uid() OR public.current_user_papel() = 'proprietario'))

-- Exemplo B — tabela só do gestor (admin-only de verdade): proprietario-only.
ALTER TABLE public.calendar_events_sync ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS calendar_events_sync_owner_all ON public.calendar_events_sync;
CREATE POLICY calendar_events_sync_owner_all ON public.calendar_events_sync
  FOR ALL TO authenticated
  USING      (public.current_user_papel() = 'proprietario')
  WITH CHECK (public.current_user_papel() = 'proprietario');

-- ... adicione um par por tabela desprotegida que F-11.a listar ...

    >>> FIM DO TEMPLATE <<<  */


-- ============================================================================
-- Sem blocos descomentados, este arquivo é NO-OP. Preencha a partir de F-11.a
-- (somente as tabelas realmente desprotegidas) antes de aplicar.
-- ============================================================================
