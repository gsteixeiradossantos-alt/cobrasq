-- Migration: Fase C — bugs sérios
--   B4: tabelas dedicadas para idempotência e histórico da régua de cobrança.
--       O cron-regua para de mutar cobrasq_data inteiro (que sobrescrevia
--       edições paralelas do usuário).
--   B7: soft-delete em calendar_events_sync para permitir cleanup remoto
--       dos eventos do Google Calendar quando a entidade-origem é apagada.

-- =============================================================
-- B4 — REGUA: idempotência por (tipo, devedor, parcela, passo)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.regua_envios (
  id           BIGSERIAL PRIMARY KEY,
  tipo         TEXT NOT NULL CHECK (tipo IN ('cobranca','acordo')),
  devedor_id   TEXT NOT NULL,            -- id do devedor (hoje no JSONB)
  parcela_id   TEXT NOT NULL DEFAULT '', -- '' quando tipo='cobranca'
  step_key     TEXT NOT NULL,
  canal        TEXT NOT NULL,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status       TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed','dry','skipped')),
  error        TEXT,
  UNIQUE (tipo, devedor_id, parcela_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_regua_envios_dev      ON public.regua_envios(devedor_id);
CREATE INDEX IF NOT EXISTS idx_regua_envios_sent_at  ON public.regua_envios(sent_at DESC);

ALTER TABLE public.regua_envios ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "regua_service_all"   ON public.regua_envios;
DROP POLICY IF EXISTS "regua_staff_read"    ON public.regua_envios;

-- Apenas service-role (cron) escreve; staff lê para auditoria
CREATE POLICY "regua_service_all" ON public.regua_envios
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "regua_staff_read" ON public.regua_envios
  FOR SELECT TO authenticated
  USING (public.current_user_papel() IN ('proprietario','colaborador'));

-- =============================================================
-- B7 — CALENDAR: soft-delete + flag pra processar no cron
-- =============================================================
ALTER TABLE public.calendar_events_sync
  ADD COLUMN IF NOT EXISTS pending_delete BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at     TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_cal_sync_pending_delete
  ON public.calendar_events_sync(pending_delete)
  WHERE pending_delete = true AND deleted_at IS NULL;

-- Trigger: ao deletar um devedor, marca os eventos sincronizados pra remoção.
-- (Hoje só devedores é tabela normalizada; clientes/cobranças/lembretes seguem
--  no JSONB e o frontend é responsável por chamar o cleanup quando deletar.)
CREATE OR REPLACE FUNCTION public.fn_mark_calendar_orphans_on_devedor_delete()
RETURNS TRIGGER
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.calendar_events_sync
     SET pending_delete = true
   WHERE source_table = 'devedores'
     AND source_id = OLD.id
     AND deleted_at IS NULL;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_calendar_orphans_devedores ON public.devedores;
CREATE TRIGGER trg_calendar_orphans_devedores
  AFTER DELETE ON public.devedores
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_mark_calendar_orphans_on_devedor_delete();

-- Trigger function não deve ser chamável via RPC. O gatilho funciona
-- independentemente de EXECUTE (triggers não checam esse privilégio).
REVOKE EXECUTE ON FUNCTION public.fn_mark_calendar_orphans_on_devedor_delete() FROM anon, authenticated;
