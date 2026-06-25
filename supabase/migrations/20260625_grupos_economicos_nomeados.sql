-- Grupo Econômico nomeado (substitui matriz/filial na UI). JÁ APLICADA em prod via MCP.
-- Aditiva: mantém as colunas legadas clientes.cliente_grupo_id / clientes.eh_matriz.

-- 1. Tabela de grupos
CREATE TABLE IF NOT EXISTS public.grupos_economicos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.grupos_economicos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS grupos_economicos_read_authed ON public.grupos_economicos;
CREATE POLICY grupos_economicos_read_authed ON public.grupos_economicos FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS grupos_economicos_staff_write ON public.grupos_economicos;
CREATE POLICY grupos_economicos_staff_write ON public.grupos_economicos FOR ALL TO authenticated
  USING (current_user_papel() = ANY (ARRAY['proprietario','colaborador']))
  WITH CHECK (current_user_papel() = ANY (ARRAY['proprietario','colaborador']));

-- 2. Colunas FK (nullable; ON DELETE SET NULL)
ALTER TABLE public.clientes  ADD COLUMN IF NOT EXISTS grupo_economico_id uuid REFERENCES public.grupos_economicos(id) ON DELETE SET NULL;
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS grupo_economico_id uuid REFERENCES public.grupos_economicos(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_clientes_grupo_economico ON public.clientes(grupo_economico_id) WHERE grupo_economico_id IS NOT NULL;

-- 3. Função RLS espelhando current_user_grupo()
CREATE OR REPLACE FUNCTION public.current_user_grupo_economico()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT grupo_economico_id FROM public.app_users WHERE id = auth.uid() AND pode_ver_grupo = true
$$;

-- 4. RLS do portal do credor: adiciona o ramo grupo_economico_id (mantém o legado em OR)
DROP POLICY IF EXISTS clientes_cedente_grupo ON public.clientes;
CREATE POLICY clientes_cedente_grupo ON public.clientes FOR SELECT TO authenticated USING (
  (current_user_grupo_economico() IS NOT NULL AND grupo_economico_id = current_user_grupo_economico())
  OR (current_user_grupo() IS NOT NULL AND (cliente_grupo_id = current_user_grupo() OR id = current_user_grupo()))
);
DROP POLICY IF EXISTS devedores_cedente_grupo ON public.devedores;
CREATE POLICY devedores_cedente_grupo ON public.devedores FOR SELECT TO authenticated USING (
  (current_user_grupo_economico() IS NOT NULL AND cliente_id IN (SELECT id FROM public.clientes WHERE grupo_economico_id = current_user_grupo_economico()))
  OR (current_user_grupo() IS NOT NULL AND cliente_id IN (SELECT id FROM public.clientes WHERE cliente_grupo_id = current_user_grupo() OR id = current_user_grupo()))
);
