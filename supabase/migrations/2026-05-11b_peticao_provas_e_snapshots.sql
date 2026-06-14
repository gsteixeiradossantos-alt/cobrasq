-- Etapa 2: provas de dívida persistentes + snapshots em peticao_geradas
-- Aplicada em produção via MCP em 2026-05-11.

CREATE TABLE IF NOT EXISTS public.peticao_provas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  devedor_id uuid NOT NULL REFERENCES public.devedores(id) ON DELETE CASCADE,
  nome text NOT NULL,
  tipo text NOT NULL DEFAULT 'prova' CHECK (tipo IN ('prova','contrato','comprovante','foto','laudo','outro')),
  storage_path text NOT NULL,
  mime_type text,
  size_bytes bigint,
  uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  ativo boolean NOT NULL DEFAULT true,
  obs text
);

CREATE INDEX IF NOT EXISTS idx_peticao_provas_devedor ON public.peticao_provas(devedor_id) WHERE ativo;

ALTER TABLE public.peticao_provas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS provas_staff_all ON public.peticao_provas;
CREATE POLICY provas_staff_all ON public.peticao_provas
  FOR ALL
  USING (current_user_papel() = ANY (ARRAY['proprietario','colaborador']))
  WITH CHECK (current_user_papel() = ANY (ARRAY['proprietario','colaborador']));

DROP POLICY IF EXISTS provas_cedente_read ON public.peticao_provas;
CREATE POLICY provas_cedente_read ON public.peticao_provas
  FOR SELECT
  USING (devedor_id IN (
    SELECT d.id FROM devedores d JOIN clientes c ON c.id = d.cliente_id WHERE c.app_user_id = auth.uid()
  ));

ALTER TABLE public.peticao_geradas
  ADD COLUMN IF NOT EXISTS template_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS dados_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS provas_ids uuid[];

CREATE INDEX IF NOT EXISTS idx_peticao_geradas_devedor ON public.peticao_geradas(devedor_id);
