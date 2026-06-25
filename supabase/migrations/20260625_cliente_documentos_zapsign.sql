-- Item 3 — rastreio de assinatura ZapSign nos documentos do cliente.
--
-- Espelha o fluxo do devedor (acordos.zapsign_doc_id): o envio registra o documento
-- com o token do ZapSign e o webhook (zapsign-webhook) casa o PDF ASSINADO de volta
-- por zapsign_doc_id, gravando assinado_storage_path e o status.
--
-- Aditiva e idempotente (ADD COLUMN IF NOT EXISTS) — não afeta linhas/uploads
-- existentes; colunas ficam NULL para documentos que não passam pelo ZapSign.

ALTER TABLE public.cliente_documentos
  ADD COLUMN IF NOT EXISTS zapsign_doc_id        text,
  ADD COLUMN IF NOT EXISTS zapsign_status        text,   -- enviado | assinado | recusado | expirado | cancelado
  ADD COLUMN IF NOT EXISTS zapsign_signed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS assinado_storage_path text,   -- caminho do PDF assinado em peticao-assets
  ADD COLUMN IF NOT EXISTS signer_link           text;

-- Lookup do webhook por token (só linhas de assinatura; idempotente).
CREATE INDEX IF NOT EXISTS idx_cliente_documentos_zapsign
  ON public.cliente_documentos (zapsign_doc_id)
  WHERE zapsign_doc_id IS NOT NULL;
