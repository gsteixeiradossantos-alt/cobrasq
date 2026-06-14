-- Etapa 16: status real de entrega Z-API por mensagem.
-- Aplicada em produção via MCP em 2026-06-09.

CREATE TABLE IF NOT EXISTS public.crm_mensagens_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caso_id uuid REFERENCES public.devedores(id) ON DELETE CASCADE,
  message_id text UNIQUE,
  telefone_enviado text,
  status text NOT NULL CHECK (status IN ('sent','queued','delivered','read','not_delivered','failed')),
  evento_em timestamptz NOT NULL DEFAULT now(),
  raw_payload jsonb
);

CREATE INDEX IF NOT EXISTS idx_msg_status_caso ON public.crm_mensagens_status(caso_id);
CREATE INDEX IF NOT EXISTS idx_msg_status_msgid ON public.crm_mensagens_status(message_id);

ALTER TABLE public.crm_mensagens_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS msg_status_staff_all ON public.crm_mensagens_status;
CREATE POLICY msg_status_staff_all ON public.crm_mensagens_status
  FOR ALL
  USING (current_user_papel() = ANY(ARRAY['proprietario','colaborador']))
  WITH CHECK (current_user_papel() = ANY(ARRAY['proprietario','colaborador']));

COMMENT ON TABLE public.crm_mensagens_status IS 'Histórico de status real de entrega Z-API. Atualizado pelo webhook zapi-webhook.';
