-- Multi-tenant: cada operador vê só os devedores que ele cadastrou.
-- Proprietário (gestor) vê tudo.
-- Trigger seta cadastrado_por automaticamente no INSERT a partir de auth.uid().
-- Aplicada em produção via MCP em 2026-06-09.

ALTER TABLE public.devedores
  ADD COLUMN IF NOT EXISTS cadastrado_por uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_devedores_cadastrado_por ON public.devedores(cadastrado_por);

CREATE OR REPLACE FUNCTION public.fn_default_cadastrado_por()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.cadastrado_por IS NULL THEN
    NEW.cadastrado_por := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS devedores_set_cadastrado_por ON public.devedores;
CREATE TRIGGER devedores_set_cadastrado_por
  BEFORE INSERT ON public.devedores
  FOR EACH ROW EXECUTE FUNCTION public.fn_default_cadastrado_por();

UPDATE public.devedores
SET cadastrado_por = COALESCE(responsavel_id, assigned_to)
WHERE cadastrado_por IS NULL
  AND COALESCE(responsavel_id, assigned_to) IS NOT NULL;

DROP POLICY IF EXISTS devedores_staff_all ON public.devedores;

CREATE POLICY devedores_proprietario_all ON public.devedores
  FOR ALL
  USING (current_user_papel() = 'proprietario')
  WITH CHECK (current_user_papel() = 'proprietario');

CREATE POLICY devedores_colaborador_owned ON public.devedores
  FOR ALL
  USING (
    current_user_papel() = 'colaborador'
    AND (cadastrado_por = auth.uid() OR assigned_to = auth.uid())
  )
  WITH CHECK (
    current_user_papel() = 'colaborador'
    AND (cadastrado_por = auth.uid() OR assigned_to = auth.uid())
  );

DROP POLICY IF EXISTS eventos_staff_all ON public.devedor_eventos;

CREATE POLICY eventos_proprietario_all ON public.devedor_eventos
  FOR ALL
  USING (current_user_papel() = 'proprietario')
  WITH CHECK (current_user_papel() = 'proprietario');

CREATE POLICY eventos_colaborador_owned ON public.devedor_eventos
  FOR ALL
  USING (
    current_user_papel() = 'colaborador'
    AND devedor_id IN (
      SELECT id FROM public.devedores
      WHERE cadastrado_por = auth.uid() OR assigned_to = auth.uid()
    )
  )
  WITH CHECK (
    current_user_papel() = 'colaborador'
    AND devedor_id IN (
      SELECT id FROM public.devedores
      WHERE cadastrado_por = auth.uid() OR assigned_to = auth.uid()
    )
  );

COMMENT ON COLUMN public.devedores.cadastrado_por IS 'Usuário que criou o devedor (trigger default = auth.uid()). Base do multi-tenant: colaborador só vê os seus.';
