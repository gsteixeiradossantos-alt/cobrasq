-- Migration: S13 — captura de intimações via Escavador
-- Spec: docs/specs/site-app.md item S13

CREATE TABLE IF NOT EXISTS public.proc_intimacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fonte TEXT NOT NULL DEFAULT 'escavador' CHECK (fonte IN ('escavador','jusbrasil','codilo','manual')),
  processo_num TEXT,
  oab TEXT,
  data_publicacao DATE,
  data_intimacao DATE,
  conteudo TEXT,
  link_diario TEXT,
  lida BOOLEAN NOT NULL DEFAULT false,
  devedor_id UUID REFERENCES public.devedores(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intimacoes_processo ON public.proc_intimacoes(processo_num) WHERE processo_num IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intimacoes_devedor ON public.proc_intimacoes(devedor_id) WHERE devedor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intimacoes_lida ON public.proc_intimacoes(lida) WHERE lida = false;
CREATE INDEX IF NOT EXISTS idx_intimacoes_data ON public.proc_intimacoes(data_publicacao DESC);

ALTER TABLE public.proc_intimacoes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "intimacoes_select" ON public.proc_intimacoes FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "intimacoes_insert" ON public.proc_intimacoes FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "intimacoes_update" ON public.proc_intimacoes FOR UPDATE USING (auth.uid() IS NOT NULL);
