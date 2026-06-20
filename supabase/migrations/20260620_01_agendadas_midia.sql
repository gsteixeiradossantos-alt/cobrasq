-- ============================================================
-- Agendamento de mensagens WhatsApp — suporte a mídia
-- ============================================================
-- Estende public.crm_mensagens_agendadas (criada em
-- 2026-05-10_crm_mensagens_agendadas.sql) para suportar, além de texto,
-- o agendamento de áudio (nota de voz) e documentos, e o vínculo com o
-- devedor do app Faturamento (que opera sobre `devedores`, não `casos`).
--
-- Mudança ADITIVA e idempotente: apenas ADD COLUMN / CHECK / DROP NOT NULL.
-- Nenhuma redefinição de view ou policy existente. RLS atual já cobre o
-- novo fluxo (INSERT com operador_id = auth.uid(); SELECT/UPDATE owner-or-admin).
--
-- O worker `cron-mensagens-agendadas` passa a ramificar o envio por `tipo`
-- e a gerar signed URL da mídia (bucket `documentos`) no momento do disparo.

ALTER TABLE public.crm_mensagens_agendadas
  ADD COLUMN IF NOT EXISTS tipo       text NOT NULL DEFAULT 'texto',  -- texto | audio | documento | imagem
  ADD COLUMN IF NOT EXISTS media_path text,   -- caminho do arquivo no bucket 'documentos'
  ADD COLUMN IF NOT EXISTS media_nome text,   -- nome original (usado como fileName em documentos)
  ADD COLUMN IF NOT EXISTS media_mime text,   -- content-type do arquivo
  ADD COLUMN IF NOT EXISTS legenda    text,   -- caption de documento/imagem
  ADD COLUMN IF NOT EXISTS devedor_id uuid REFERENCES public.devedores(id) ON DELETE SET NULL;

-- Restringe os valores de `tipo` (idempotente: cria só se ainda não existir).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crm_msg_tipo_chk'
  ) THEN
    ALTER TABLE public.crm_mensagens_agendadas
      ADD CONSTRAINT crm_msg_tipo_chk
      CHECK (tipo IN ('texto', 'audio', 'documento', 'imagem'));
  END IF;
END$$;

-- Áudio/documento podem não ter texto: `mensagem` deixa de ser obrigatória.
ALTER TABLE public.crm_mensagens_agendadas ALTER COLUMN mensagem DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_msg_agendada_devedor
  ON public.crm_mensagens_agendadas(devedor_id);
