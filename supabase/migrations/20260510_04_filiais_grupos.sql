-- Migration: S6 — empresas com filiais (matriz/grupo)
-- Spec: docs/specs/site-app.md item S6

ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS cliente_grupo_id UUID REFERENCES public.clientes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS eh_matriz BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_clientes_grupo ON public.clientes(cliente_grupo_id);

-- Schema users: flag e vínculo de grupo (gestor)
-- Atenção: tabela `users` no Supabase pode ser auth.users ou public.users. Ajustar conforme schema real.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    EXECUTE 'ALTER TABLE public.users
      ADD COLUMN IF NOT EXISTS pode_ver_grupo BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS cliente_grupo_id UUID REFERENCES public.clientes(id) ON DELETE SET NULL';
  END IF;
END $$;

-- Comentário: a lógica de RLS (gestor vê todos clientes do mesmo cliente_grupo_id)
-- precisa ser aplicada nas políticas existentes de clientes/devedores. Fazer revisão
-- caso-a-caso após este schema.
