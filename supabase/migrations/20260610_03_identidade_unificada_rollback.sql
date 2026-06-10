-- ============================================================================
-- ROLLBACK F-05 — desfaz 20260610_03_identidade_unificada.sql
-- ============================================================================
-- Duas metades rotuladas, espelhando as duas opções da migration. Descomente
-- SOMENTE a(s) metade(s) correspondente(s) ao que foi aplicado.
--
-- ECOSSISTEMA: Supabase jokbxzhcctcwnbhkhgru (faturamento + CRM). Testar os
-- dois apps por papel após reverter.
-- ============================================================================


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ ROLLBACK DA OPÇÃO A — remove o trigger/função de sync                       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
/*  >>> DESCOMENTE SE A OPÇÃO A FOI APLICADA <<<

DROP TRIGGER IF EXISTS trg_profile_sync_app_user ON public.profiles;
DROP FUNCTION IF EXISTS public.fn_sync_profile_to_app_user();

-- NOTA: o backfill A.1 (linhas inseridas/atualizadas em app_users) NÃO é
--   automaticamente revertido — apagá-las poderia tirar acesso de quem já
--   dependia delas. Se PRECISAR remover só as linhas criadas pelo backfill,
--   faça-o manualmente e com critério (identifique-as antes; não há marca de
--   origem por padrão). Em geral, manter as linhas é o mais seguro.

    >>> FIM ROLLBACK A <<<  */


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ ROLLBACK DA OPÇÃO B — restaura as policies baseadas em profiles.role        ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║ ⚠️ Os corpos abaixo são TEMPLATE. Antes de reverter, recupere a definição    ║
-- ║ ORIGINAL exata das policies (do dump pré-mudança ou de F-05.f executado      ║
-- ║ ANTES do apply) e cole aqui — senão você recria uma policy que pode não bater ║
-- ║ com a original.                                                              ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
/*  >>> DESCOMENTE E AJUSTE SE A OPÇÃO B FOI APLICADA <<<

-- B.1 rollback — crm_mensagens_agendadas volta a checar profiles.role.
DROP POLICY IF EXISTS "crm_mensagens_agendadas_staff" ON public.crm_mensagens_agendadas;
CREATE POLICY "crm_mensagens_agendadas_staff" ON public.crm_mensagens_agendadas
  FOR ALL TO authenticated
  USING      (EXISTS (SELECT 1 FROM public.profiles pr
                      WHERE pr.id = auth.uid()
                        AND pr.role IN ('admin','owner','gestor','staff')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles pr
                      WHERE pr.id = auth.uid()
                        AND pr.role IN ('admin','owner','gestor','staff')));

-- B.2 rollback — crm_envios_falhados idem.
DROP POLICY IF EXISTS "crm_envios_falhados_staff" ON public.crm_envios_falhados;
CREATE POLICY "crm_envios_falhados_staff" ON public.crm_envios_falhados
  FOR ALL TO authenticated
  USING      (EXISTS (SELECT 1 FROM public.profiles pr
                      WHERE pr.id = auth.uid()
                        AND pr.role IN ('admin','owner','gestor','staff')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles pr
                      WHERE pr.id = auth.uid()
                        AND pr.role IN ('admin','owner','gestor','staff')));

    >>> FIM ROLLBACK B <<<  */
