-- ============================================================
-- Menu "Audiências" — agenda de audiências (JEC/PROJUDI) com
-- lembretes automáticos via WhatsApp reaproveitando o worker
-- já existente de crm_mensagens_agendadas (pg_cron a cada 1 min
-- -> edge function cron-mensagens-agendadas -> Z-API).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.audiencias (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_processo     text NOT NULL,
  comarca             text,
  orgao_julgador      text,
  tipo_audiencia      text NOT NULL DEFAULT 'Audiência de conciliação',
  sala                text,
  data_hora           timestamptz NOT NULL,
  previsao_termino    timestamptz,
  partes              jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{"nome":"...", "papel":"AUTOR"|"REU"}]
  observacao          text,
  telefone_notificacao text NOT NULL DEFAULT '46999223332',
  cobranca_id         uuid REFERENCES public.cobrancas(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'agendada', -- agendada | realizada | cancelada | remarcada
  origem              text NOT NULL DEFAULT 'manual',    -- manual | projudi_import
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audiencias_data_hora ON public.audiencias(data_hora);
CREATE INDEX IF NOT EXISTS idx_audiencias_status ON public.audiencias(status);

-- Vínculo com a fila de disparo já existente: cada audiência gera até 3 linhas
-- em crm_mensagens_agendadas (D-1 19h, dia D 08h, 10min antes). Cancelar a
-- audiência cancela em cascata os lembretes ainda não enviados.
ALTER TABLE public.crm_mensagens_agendadas
  ADD COLUMN IF NOT EXISTS audiencia_id uuid REFERENCES public.audiencias(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_crm_msg_agendada_audiencia ON public.crm_mensagens_agendadas(audiencia_id);

-- ------------------------------------------------------------
-- RLS — mesmo modelo de papéis de cobrancas (current_user_papel()):
-- proprietario gerencia tudo; colaborador só enxerga (agenda é
-- informação de equipe, não precisa ficar restrita por caso).
-- ------------------------------------------------------------
ALTER TABLE public.audiencias ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audiencias_proprietario_all ON public.audiencias;
CREATE POLICY audiencias_proprietario_all
  ON public.audiencias
  FOR ALL
  USING (current_user_papel() = 'proprietario')
  WITH CHECK (current_user_papel() = 'proprietario');

DROP POLICY IF EXISTS audiencias_colaborador_select ON public.audiencias;
CREATE POLICY audiencias_colaborador_select
  ON public.audiencias
  FOR SELECT
  USING (current_user_papel() = 'colaborador');

-- Reaproveita public.set_updated_at() já existente no projeto.
DROP TRIGGER IF EXISTS trg_audiencias_updated_at ON public.audiencias;
CREATE TRIGGER trg_audiencias_updated_at
  BEFORE UPDATE ON public.audiencias
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
