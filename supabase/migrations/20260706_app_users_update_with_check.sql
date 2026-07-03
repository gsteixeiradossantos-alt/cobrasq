-- ✅ APLICADA EM PRODUÇÃO 2026-07-06 (via MCP, projeto jokbxzhcctcwnbhkhgru). Não reaplicar.
-- ============================================================================
-- Defesa em profundidade da correção de escalação de app_users
-- (complementa 20260706_app_users_privilege_lock.sql — o trigger é a proteção
-- principal e completa; este WITH CHECK é redundante e serve de segunda camada).
--
-- A policy users_update_self_or_owner (UPDATE, authenticated) tinha USING mas NÃO
-- tinha WITH CHECK, então a NEW row não era restringida. Adiciona um WITH CHECK que,
-- na camada de RLS, impede um NÃO-proprietário de setar o PRÓPRIO papel='proprietario'.
--
-- Escopo/limites (por isso o trigger continua sendo a proteção principal):
--   * WITH CHECK NÃO cobre as colunas de grupo (pode_ver_grupo/grupo_economico_id/
--     cliente_grupo_id) — RLS não compara NEW vs OLD, só barra VALORES da NEW; para
--     "não pode ALTERAR" é preciso o trigger.
--   * NÃO cobre a view profiles (INSTEAD OF, SECURITY DEFINER) que bypassa a RLS.
--
-- Verificado em prod (SET ROLE authenticated + JWT de colaborador, com rollback):
--   self-edit legítimo (nome) PASSOU; papel→proprietario BLOQUEADO (42501).
-- ============================================================================

alter policy users_update_self_or_owner on public.app_users
  with check (
    public.current_user_papel() = 'proprietario'
    or (id = auth.uid() and coalesce(papel, '') <> 'proprietario')
  );

-- Rollback (volta ao estado sem WITH CHECK — o USING passa a valer também como check):
--   alter policy users_update_self_or_owner on public.app_users with check (
--     (id = auth.uid()) or (public.current_user_papel() = 'proprietario')
--   );
