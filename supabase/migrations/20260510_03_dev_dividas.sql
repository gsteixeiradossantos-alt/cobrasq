-- Migration: S2 — múltiplas dívidas por devedor
-- Spec: docs/specs/site-app.md item S2

CREATE TABLE IF NOT EXISTS public.dev_dividas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  devedor_id UUID NOT NULL REFERENCES public.devedores(id) ON DELETE CASCADE,
  valor_original NUMERIC(14,2) NOT NULL,
  valor_atualizado NUMERIC(14,2),
  vencimento DATE,
  entrada_carteira DATE,
  descricao TEXT,
  status TEXT NOT NULL DEFAULT 'aberta',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dev_dividas_devedor ON public.dev_dividas(devedor_id);
CREATE INDEX IF NOT EXISTS idx_dev_dividas_status ON public.dev_dividas(status);

ALTER TABLE public.dev_dividas ENABLE ROW LEVEL SECURITY;

-- RLS herda de devedores: usuário vê dívida se vê o devedor
CREATE POLICY "dividas_select_via_devedor" ON public.dev_dividas FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.devedores d WHERE d.id = devedor_id)
);
CREATE POLICY "dividas_insert_via_devedor" ON public.dev_dividas FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.devedores d WHERE d.id = devedor_id)
);
CREATE POLICY "dividas_update_via_devedor" ON public.dev_dividas FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.devedores d WHERE d.id = devedor_id)
);
CREATE POLICY "dividas_delete_via_devedor" ON public.dev_dividas FOR DELETE USING (
  EXISTS (SELECT 1 FROM public.devedores d WHERE d.id = devedor_id)
);
