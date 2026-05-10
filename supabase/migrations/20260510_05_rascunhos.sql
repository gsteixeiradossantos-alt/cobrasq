-- Migration: S12 — rascunhos de cadastro
-- Spec: docs/specs/site-app.md item S12

ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS is_draft BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS draft_expires_at TIMESTAMPTZ;

ALTER TABLE public.devedores
  ADD COLUMN IF NOT EXISTS is_draft BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS draft_expires_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'processos') THEN
    EXECUTE 'ALTER TABLE public.processos
      ADD COLUMN IF NOT EXISTS is_draft BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS draft_expires_at TIMESTAMPTZ';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_clientes_draft ON public.clientes(is_draft) WHERE is_draft = true;
CREATE INDEX IF NOT EXISTS idx_devedores_draft ON public.devedores(is_draft) WHERE is_draft = true;

-- Cron de cleanup (30 dias). Se pg_cron não disponível, rodar via Edge Function diária.
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('cleanup_drafts', '0 3 * * *', $$
--   DELETE FROM public.clientes WHERE is_draft = true AND updated_at < now() - interval '30 days';
--   DELETE FROM public.devedores WHERE is_draft = true AND updated_at < now() - interval '30 days';
-- $$);
