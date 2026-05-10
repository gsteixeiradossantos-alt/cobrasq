-- Migration: C2 — persistência de cálculos da Calculadora Jurídica
-- Spec: docs/specs/calculadora.md item C2
-- Aplicar após review.

CREATE TABLE IF NOT EXISTS public.calc_calculos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL DEFAULT ('Cálculo de ' || to_char(now(), 'DD/MM/YYYY HH24:MI')),
  vinculo_livre TEXT,
  devedor_id UUID REFERENCES public.devedores(id) ON DELETE SET NULL,
  processo_num TEXT,
  snapshot_inputs JSONB NOT NULL,
  snapshot_resultado JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calc_calculos_owner ON public.calc_calculos(owner_id, atualizado_em DESC);
CREATE INDEX IF NOT EXISTS idx_calc_calculos_devedor ON public.calc_calculos(devedor_id) WHERE devedor_id IS NOT NULL;

ALTER TABLE public.calc_calculos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_select" ON public.calc_calculos FOR SELECT USING (auth.uid() = owner_id);
CREATE POLICY "owner_insert" ON public.calc_calculos FOR INSERT WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "owner_update" ON public.calc_calculos FOR UPDATE USING (auth.uid() = owner_id);
CREATE POLICY "owner_delete" ON public.calc_calculos FOR DELETE USING (auth.uid() = owner_id);

CREATE OR REPLACE FUNCTION public.touch_calc_calculos()
RETURNS TRIGGER AS $$
BEGIN
  NEW.atualizado_em := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_calc_calculos_touch
  BEFORE UPDATE ON public.calc_calculos
  FOR EACH ROW EXECUTE FUNCTION public.touch_calc_calculos();
