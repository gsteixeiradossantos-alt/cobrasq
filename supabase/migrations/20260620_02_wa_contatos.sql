-- ============================================================
-- Contatos avulsos de WhatsApp (agendamento)
-- ============================================================
-- Lista leve de contatos (nome + telefone) para reuso no compositor da aba
-- WhatsApp → Agendados, quando o destinatário não é um devedor cadastrado.
-- Não polui a tela Devedores e não expira como rascunho.
-- O agendamento (crm_mensagens_agendadas) grava `telefone` direto; `devedor_id`
-- só é preenchido quando o destinatário é um devedor real.

CREATE TABLE IF NOT EXISTS public.wa_contatos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome        text NOT NULL,
  telefone    text NOT NULL,            -- dígitos normalizados (ex: 5546999990000)
  operador_id uuid REFERENCES auth.users(id) DEFAULT auth.uid(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_contatos_tel ON public.wa_contatos(telefone);

ALTER TABLE public.wa_contatos ENABLE ROW LEVEL SECURITY;

-- App interno de uma única organização: qualquer usuário autenticado lê/gerencia.
DROP POLICY IF EXISTS wa_contatos_select ON public.wa_contatos;
CREATE POLICY wa_contatos_select ON public.wa_contatos FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS wa_contatos_insert ON public.wa_contatos;
CREATE POLICY wa_contatos_insert ON public.wa_contatos FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS wa_contatos_update ON public.wa_contatos;
CREATE POLICY wa_contatos_update ON public.wa_contatos FOR UPDATE USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS wa_contatos_delete ON public.wa_contatos;
CREATE POLICY wa_contatos_delete ON public.wa_contatos FOR DELETE USING (auth.uid() IS NOT NULL);
