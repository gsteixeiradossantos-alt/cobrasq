-- Etapa 3: versionamento + categorização de peticao_templates
-- Aplicada em produção via MCP em 2026-05-11.

ALTER TABLE public.peticao_templates
  ADD COLUMN IF NOT EXISTS versao integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS prev_versao_id uuid REFERENCES public.peticao_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS requisitos jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_peticao_templates_tipo') THEN
    ALTER TABLE public.peticao_templates
      ADD CONSTRAINT chk_peticao_templates_tipo CHECK (
        tipo IN (
          'inicial_cobranca','monitoria','execucao_titulo','execucao_extrajudicial',
          'protesto','busca_apreensao','despejo','arrolamento','outro'
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_peticao_templates_tipo_ativo ON public.peticao_templates(tipo, ativo) WHERE ativo;

COMMENT ON COLUMN public.peticao_templates.versao IS 'Versão monotônica. Editar template = INSERT nova versão + UPDATE prev_versao_id na anterior.';
COMMENT ON COLUMN public.peticao_templates.requisitos IS 'JSONB com gates pra UI: {"requer_titulo_executivo": bool, "requer_garantia": bool, ...}';
