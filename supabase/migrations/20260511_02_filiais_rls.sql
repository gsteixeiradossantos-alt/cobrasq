-- Migration: SEC-N6 — Implementa a RLS de filiais (S6) que ficou pendente.
-- A migration 20260510_04_filiais_grupos.sql:
--   • adicionou cliente_grupo_id em public.clientes
--   • tentou adicionar pode_ver_grupo / cliente_grupo_id em public.users
--     (mas a tabela real do projeto é public.app_users — o bloco DO $$ foi no-op)
--   • deixou comentado que as policies precisam ser revisitadas
--
-- Esta migration:
--   1. Garante que pode_ver_grupo / cliente_grupo_id existam em public.app_users.
--   2. Adiciona policies de leitura por grupo em clientes e devedores
--      sem remover as policies existentes (staff_all e cedente_scope).
--
-- Modelo:
--   - Cedente com cliente_grupo_id setado e pode_ver_grupo=true
--     enxerga todos os clientes do mesmo grupo (e seus devedores).
--   - Sem o flag, cai no escopo estrito (apenas seus próprios clientes).

-- 1) Colunas em app_users
ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS pode_ver_grupo BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS cliente_grupo_id UUID REFERENCES public.clientes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_app_users_grupo
  ON public.app_users(cliente_grupo_id)
  WHERE cliente_grupo_id IS NOT NULL;

-- 2) Helper: grupo do usuário autenticado (NULL se não tiver permissão de grupo)
CREATE OR REPLACE FUNCTION public.current_user_grupo()
RETURNS UUID
LANGUAGE SQL
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cliente_grupo_id
  FROM public.app_users
  WHERE id = auth.uid()
    AND pode_ver_grupo = true
$$;

-- 3) Policy de grupo em clientes (SELECT)
DROP POLICY IF EXISTS "clientes_cedente_grupo" ON public.clientes;
CREATE POLICY "clientes_cedente_grupo" ON public.clientes
  FOR SELECT TO authenticated
  USING (
    public.current_user_grupo() IS NOT NULL
    AND (
      cliente_grupo_id = public.current_user_grupo()
      OR id = public.current_user_grupo()
    )
  );

-- 4) Policy de grupo em devedores (SELECT)
DROP POLICY IF EXISTS "devedores_cedente_grupo" ON public.devedores;
CREATE POLICY "devedores_cedente_grupo" ON public.devedores
  FOR SELECT TO authenticated
  USING (
    public.current_user_grupo() IS NOT NULL
    AND cliente_id IN (
      SELECT id FROM public.clientes
      WHERE cliente_grupo_id = public.current_user_grupo()
         OR id = public.current_user_grupo()
    )
  );
