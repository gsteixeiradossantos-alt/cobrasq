-- Etapa 13: histórico de conversas IA pra petição
-- Aplicada em produção via MCP em 2026-05-11.

CREATE TABLE IF NOT EXISTS public.peticao_conversas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  devedor_id uuid REFERENCES public.devedores(id) ON DELETE CASCADE,
  template_id uuid REFERENCES public.peticao_templates(id) ON DELETE SET NULL,
  owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  mensagens jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_peticao_conversas_devedor ON public.peticao_conversas(devedor_id);
CREATE INDEX IF NOT EXISTS idx_peticao_conversas_owner ON public.peticao_conversas(owner_id);

ALTER TABLE public.peticao_conversas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conv_staff_all ON public.peticao_conversas;
CREATE POLICY conv_staff_all ON public.peticao_conversas
  FOR ALL
  USING (current_user_papel() = ANY(ARRAY['proprietario','colaborador']))
  WITH CHECK (current_user_papel() = ANY(ARRAY['proprietario','colaborador']));

DROP POLICY IF EXISTS conv_owner ON public.peticao_conversas;
CREATE POLICY conv_owner ON public.peticao_conversas
  FOR ALL
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

DROP TRIGGER IF EXISTS conversas_updated_at ON public.peticao_conversas;
CREATE TRIGGER conversas_updated_at BEFORE UPDATE ON public.peticao_conversas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.peticao_conversas IS 'Histórico de conversa com Claude (peticao-assistente) — uma linha por wizard.';
