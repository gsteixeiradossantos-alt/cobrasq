-- ============================================================
-- Item #11 — Mensagens agendadas e auto-cobrança ZapSign
-- ============================================================
-- Tabela de mensagens agendadas pra envio futuro via Z-API.
-- Worker (cron / Edge Function) consome onde agendada_para <= now()
-- e status='pendente', envia, marca como 'enviada' ou 'falhou'.

CREATE TABLE IF NOT EXISTS public.crm_mensagens_agendadas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caso_id      uuid REFERENCES public.casos(id) ON DELETE CASCADE,
  operador_id  uuid REFERENCES auth.users(id),
  telefone     text NOT NULL,
  mensagem     text NOT NULL,
  agendada_para timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'pendente',  -- pendente | enviada | falhou | cancelada
  tentativas   int NOT NULL DEFAULT 0,
  erro         text,
  enviada_em   timestamptz,
  origem       text DEFAULT 'manual',  -- manual | auto_cobranca_24h | auto_cobranca_48h | auto_cobranca_72h
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_msg_agendada_status_data
  ON public.crm_mensagens_agendadas(status, agendada_para);
CREATE INDEX IF NOT EXISTS idx_crm_msg_agendada_caso
  ON public.crm_mensagens_agendadas(caso_id);

-- ------------------------------------------------------------
-- RLS — operador só vê/edita mensagens dos casos dele;
-- admin vê todas.
-- ------------------------------------------------------------
ALTER TABLE public.crm_mensagens_agendadas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS msg_agendada_select_owner ON public.crm_mensagens_agendadas;
CREATE POLICY msg_agendada_select_owner
  ON public.crm_mensagens_agendadas
  FOR SELECT
  USING (
    operador_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin' AND p.ativo = true
    )
  );

DROP POLICY IF EXISTS msg_agendada_insert_owner ON public.crm_mensagens_agendadas;
CREATE POLICY msg_agendada_insert_owner
  ON public.crm_mensagens_agendadas
  FOR INSERT
  WITH CHECK (operador_id = auth.uid());

DROP POLICY IF EXISTS msg_agendada_update_owner ON public.crm_mensagens_agendadas;
CREATE POLICY msg_agendada_update_owner
  ON public.crm_mensagens_agendadas
  FOR UPDATE
  USING (
    operador_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin' AND p.ativo = true
    )
  );

-- ============================================================
-- Item #2 — Falhas de envio Z-API (retry queue)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.crm_envios_falhados (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caso_id      uuid REFERENCES public.casos(id) ON DELETE CASCADE,
  operador_id  uuid REFERENCES auth.users(id),
  telefone     text NOT NULL,
  mensagem     text NOT NULL,
  erro         text,
  tentativas   int NOT NULL DEFAULT 1,
  status       text NOT NULL DEFAULT 'pendente',  -- pendente | reenviada | descartada
  retry_at     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_envios_falhados_status
  ON public.crm_envios_falhados(status, created_at);

ALTER TABLE public.crm_envios_falhados ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS envios_falhados_select ON public.crm_envios_falhados;
CREATE POLICY envios_falhados_select
  ON public.crm_envios_falhados
  FOR SELECT
  USING (
    operador_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin' AND p.ativo = true
    )
  );

DROP POLICY IF EXISTS envios_falhados_insert ON public.crm_envios_falhados;
CREATE POLICY envios_falhados_insert
  ON public.crm_envios_falhados
  FOR INSERT
  WITH CHECK (operador_id = auth.uid() OR operador_id IS NULL);

-- ============================================================
-- Colunas adicionais na tabela `casos` pros itens #1, #15, #17
-- ============================================================
ALTER TABLE public.casos
  ADD COLUMN IF NOT EXISTS objecao_adicionais   jsonb,
  ADD COLUMN IF NOT EXISTS mesa_gestor          jsonb,
  ADD COLUMN IF NOT EXISTS endereco             jsonb,
  ADD COLUMN IF NOT EXISTS checklist_judicial   jsonb;
