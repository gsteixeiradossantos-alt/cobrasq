-- Etapa 5: acordos.status_zapsign com CHECK + colunas extras pra webhook
-- Aplicada em produção via MCP em 2026-05-11.

ALTER TABLE public.acordos
  ADD COLUMN IF NOT EXISTS zapsign_doc_id text,
  ADD COLUMN IF NOT EXISTS zapsign_evento_em timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_acordos_status_zapsign') THEN
    ALTER TABLE public.acordos
      ADD CONSTRAINT chk_acordos_status_zapsign CHECK (
        status_zapsign IS NULL OR status_zapsign IN (
          'pendente','enviado','visualizado','assinado','recusado','expirado','cancelado'
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_acordos_zapsign_doc_id ON public.acordos(zapsign_doc_id) WHERE zapsign_doc_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_acordos_devedor ON public.acordos(devedor_id);

COMMENT ON COLUMN public.acordos.zapsign_doc_id IS 'ID externo do documento no ZapSign (vem no payload do webhook como external_id ou doc.token).';
COMMENT ON COLUMN public.acordos.status_zapsign IS 'Status real do documento (atualizado por zapsign-webhook). Antes era heurística por tempo.';
