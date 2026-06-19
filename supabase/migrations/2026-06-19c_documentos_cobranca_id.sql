-- ============================================================================
-- Anexos por dívida (FASE C2) — reusa a tabela/bucket `documentos` existente.
-- Adiciona `cobranca_id` para que um documento possa ser ANEXO de uma cobrança
-- (cheque-frente, contrato, prints), além do vínculo por devedor. Aditivo,
-- reversível, não toca RLS (continua governada por devedor_id/responsável).
-- Aplicar via Supabase MCP. Rollback: 2026-06-19c_documentos_cobranca_id_rollback.sql
-- ============================================================================
ALTER TABLE public.documentos ADD COLUMN IF NOT EXISTS cobranca_id TEXT;
CREATE INDEX IF NOT EXISTS idx_documentos_cobranca
  ON public.documentos(cobranca_id) WHERE cobranca_id IS NOT NULL;
COMMENT ON COLUMN public.documentos.cobranca_id IS
  'Quando preenchido, o documento é um ANEXO desta cobrança (além do vínculo por devedor). FASE C2.';
