-- Assinaturas avulsas — histórico do menu "Assinaturas" (envio de PDF qualquer ao ZapSign
-- sem cadastrar no painel do ZapSign). Cada linha = um envio (1 signatário, 1+ PDFs num
-- único link). O status é atualizado sob demanda pelo app via ZapSignAPI.getDoc (o webhook
-- zapsign-webhook NÃO toca nesta tabela).
--
-- APLICAR MANUALMENTE no SQL Editor do projeto jokbxzhcctcwnbhkhgru antes do deploy
-- (mesmo padrão das outras features recentes). Rollback em _rollback.sql.

CREATE TABLE IF NOT EXISTS public.assinaturas_avulsas (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo               text,                          -- nome do envio (ex.: "Procuração — Fulano")
  signer_nome          text NOT NULL,
  signer_tel           text,
  signer_email         text,
  n_docs               int  NOT NULL DEFAULT 1,       -- quantos PDFs no mesmo link
  zapsign_doc_token    text,                          -- token do documento no ZapSign
  zapsign_signer_token text,                          -- token do signatário
  signer_link          text,                          -- link de assinatura
  status               text NOT NULL DEFAULT 'PENDING', -- PENDING/SIGNED/REFUSED/EXPIRED/CANCELLED
  storage_paths        text[] DEFAULT '{}',           -- PDFs originais no bucket 'documentos' (melhor-esforço)
  created_by           uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  assinado_em          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_assinaturas_avulsas_created_at ON public.assinaturas_avulsas(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assinaturas_avulsas_doc_token  ON public.assinaturas_avulsas(zapsign_doc_token);

ALTER TABLE public.assinaturas_avulsas ENABLE ROW LEVEL SECURITY;

-- Staff (proprietário + colaborador) faz tudo. Documentos avulsos são internos do escritório;
-- mesmo padrão de peticao_conversas/peticao_provas. Cedente e devedor NÃO acessam.
DROP POLICY IF EXISTS assinaturas_avulsas_staff_all ON public.assinaturas_avulsas;
CREATE POLICY assinaturas_avulsas_staff_all ON public.assinaturas_avulsas
  FOR ALL
  USING (current_user_papel() = ANY(ARRAY['proprietario','colaborador']))
  WITH CHECK (current_user_papel() = ANY(ARRAY['proprietario','colaborador']));

COMMENT ON TABLE public.assinaturas_avulsas IS 'Histórico do menu Assinaturas — envio avulso de PDF ao ZapSign (1 signatário, N PDFs/link). Status atualizado sob demanda via getDoc.';
