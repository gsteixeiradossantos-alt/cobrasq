-- ============================================================================
-- Menu "Lembretes" — tarefas e lembretes avulsos com aviso automático por
-- WhatsApp, no MESMO mecanismo das audiências (fila crm_mensagens_agendadas ->
-- pg_cron 1min -> edge function cron-mensagens-agendadas -> Z-API).
--
-- NÃO APLICADA EM PRODUÇÃO (aguardando autorização).
--
-- POR QUE UMA TABELA NOVA e não a de audiências. Em 04/09/2026 um lembrete
-- ("avisar a cedente Injet-Car sobre a desistência") foi gravado em
-- `audiencias` só para receber os 3 WhatsApps do trigger. Funcionou, mas o
-- texto saiu como "audiência amanhã", a tela de audiências passou a listar
-- uma coisa que não é audiência, e a skill audiencias-cobrasq já proíbe esse
-- uso. Decisão do gestor (04/09/2026): não mexer no que está certo; criar um
-- módulo irmão, com tabela, trigger e tela próprios.
--
-- O QUE ESTE ARQUIVO FAZ
--   1. Tabela public.lembretes (título, descrição, data/hora, processo e
--      cobrança opcionais, telefone de aviso, status).
--   2. crm_mensagens_agendadas.lembrete_id (FK, ON DELETE CASCADE) — igual ao
--      audiencia_id: excluir o lembrete apaga os avisos ainda na fila.
--   3. RLS igual à de audiencias: proprietário tudo, colaborador só lê.
--   4. Trigger lembretes_agendar_avisos(): 3 avisos (véspera 19h, dia 08h,
--      10 min antes), origem 'lembrete_aviso_<fase>', operador_id = auth.uid()
--      (lição R-18 / 20260729_fix_audiencias_trigger_operador_id.sql) e
--      SET search_path = public (advisor function_search_path_mutable).
--
-- VERIFICAÇÃO (R-18) — antes de aplicar, rodou-se este arquivo inteiro dentro
-- de um bloco DO que insere como gestor e como colaborador (JWT simulado) e
-- termina em RAISE EXCEPTION, de modo que nada persiste. Resultado esperado:
-- gestor insere e gera 3 avisos; colaborador lê mas não insere (RLS).
--
-- ROLLBACK
--   drop trigger if exists trg_lembretes_agendar_avisos on public.lembretes;
--   drop function if exists public.lembretes_agendar_avisos();
--   alter table public.crm_mensagens_agendadas drop column if exists lembrete_id;
--   drop table if exists public.lembretes;
-- ============================================================================

begin;

CREATE TABLE IF NOT EXISTS public.lembretes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo               text NOT NULL,
  descricao            text,
  data_hora            timestamptz NOT NULL,
  numero_processo      text,
  cobranca_id          uuid REFERENCES public.cobrancas(id) ON DELETE SET NULL,
  telefone_notificacao text NOT NULL DEFAULT '46999223332',
  status               text NOT NULL DEFAULT 'agendado', -- agendado | concluido | cancelado
  origem               text NOT NULL DEFAULT 'manual',
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lembretes_status_chk CHECK (status IN ('agendado','concluido','cancelado'))
);

CREATE INDEX IF NOT EXISTS idx_lembretes_data_hora ON public.lembretes(data_hora);
CREATE INDEX IF NOT EXISTS idx_lembretes_status    ON public.lembretes(status);

ALTER TABLE public.crm_mensagens_agendadas
  ADD COLUMN IF NOT EXISTS lembrete_id uuid REFERENCES public.lembretes(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_crm_msg_agendada_lembrete ON public.crm_mensagens_agendadas(lembrete_id);

-- ── RLS (mesmo modelo de audiencias) ────────────────────────────────────────
ALTER TABLE public.lembretes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lembretes_proprietario_all ON public.lembretes;
CREATE POLICY lembretes_proprietario_all
  ON public.lembretes
  FOR ALL
  USING (current_user_papel() = 'proprietario')
  WITH CHECK (current_user_papel() = 'proprietario');

DROP POLICY IF EXISTS lembretes_colaborador_select ON public.lembretes;
CREATE POLICY lembretes_colaborador_select
  ON public.lembretes
  FOR SELECT
  USING (current_user_papel() = 'colaborador');

DROP TRIGGER IF EXISTS trg_lembretes_updated_at ON public.lembretes;
CREATE TRIGGER trg_lembretes_updated_at
  BEFORE UPDATE ON public.lembretes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Trigger de avisos ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lembretes_agendar_avisos()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  corpo    text;
  v_d1     timestamptz;
  v_dia    timestamptz;
  v_min10  timestamptz;
  v_quando text;
BEGIN
  -- Update que não mexeu em nada relevante para o aviso: não recalcula.
  IF TG_OP = 'UPDATE'
     AND NEW.data_hora = OLD.data_hora
     AND NEW.status = OLD.status
     AND NEW.telefone_notificacao IS NOT DISTINCT FROM OLD.telefone_notificacao
     AND NEW.titulo IS NOT DISTINCT FROM OLD.titulo
     AND NEW.descricao IS NOT DISTINCT FROM OLD.descricao
     AND NEW.numero_processo IS NOT DISTINCT FROM OLD.numero_processo THEN
    RETURN NEW;
  END IF;

  -- Sempre cancela os pendentes antes de recriar (idempotente).
  UPDATE public.crm_mensagens_agendadas
    SET status = 'cancelada'
    WHERE lembrete_id = NEW.id AND status = 'pendente';

  IF NEW.status <> 'agendado' THEN
    RETURN NEW; -- concluído/cancelado: só cancela, não recria.
  END IF;

  v_quando := to_char(NEW.data_hora AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY às HH24:MI');
  corpo := '*' || NEW.titulo || '*'
        || CASE WHEN coalesce(NEW.descricao,'') <> '' THEN E'\n' || NEW.descricao ELSE '' END
        || CASE WHEN coalesce(NEW.numero_processo,'') <> '' THEN E'\nProcesso: ' || NEW.numero_processo ELSE '' END
        || E'\nQuando: ' || v_quando;

  v_d1    := (((NEW.data_hora AT TIME ZONE 'America/Sao_Paulo')::date - 1) + time '19:00') AT TIME ZONE 'America/Sao_Paulo';
  v_dia   := ((NEW.data_hora AT TIME ZONE 'America/Sao_Paulo')::date + time '08:00') AT TIME ZONE 'America/Sao_Paulo';
  v_min10 := NEW.data_hora - interval '10 minutes';

  -- operador_id = auth.uid(): exigido pela policy msg_agendada_insert_owner
  -- quando quem grava é a tela (R-18). Em service_role fica NULL, inofensivo.
  INSERT INTO public.crm_mensagens_agendadas
    (lembrete_id, telefone, tipo, mensagem, agendada_para, status, origem, operador_id)
  SELECT NEW.id, NEW.telefone_notificacao, 'texto', msg, quando, 'pendente',
         'lembrete_aviso_' || fase, auth.uid()
  FROM (VALUES
    ('d1',    v_d1,    '📌 *Lembrete para amanhã*' || E'\n' || corpo),
    ('dia',   v_dia,   '📌 *Lembrete de hoje*'     || E'\n' || corpo),
    ('min10', v_min10, '⏰ *Em 10 minutos*'         || E'\n' || corpo)
  ) AS f(fase, quando, msg)
  WHERE quando > now();   -- não agenda aviso no passado

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lembretes_agendar_avisos ON public.lembretes;
CREATE TRIGGER trg_lembretes_agendar_avisos
  AFTER INSERT OR UPDATE ON public.lembretes
  FOR EACH ROW EXECUTE FUNCTION public.lembretes_agendar_avisos();

commit;
