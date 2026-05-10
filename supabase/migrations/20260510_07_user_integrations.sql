-- Migration: S10 — integrações por usuário (Google Calendar, Escavador, etc.)
-- Spec: docs/specs/site-app.md item S10

CREATE TABLE IF NOT EXISTS public.user_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google_calendar','escavador','zapsign','mercado_pago')),
  access_token TEXT,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ,
  scope TEXT,
  meta JSONB DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

ALTER TABLE public.user_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ui_owner_select" ON public.user_integrations FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "ui_owner_insert" ON public.user_integrations FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "ui_owner_update" ON public.user_integrations FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "ui_owner_delete" ON public.user_integrations FOR DELETE USING (auth.uid() = user_id);

-- Eventos sincronizados com Google Calendar (mapeamento)
CREATE TABLE IF NOT EXISTS public.calendar_events_sync (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  google_event_id TEXT NOT NULL,
  source_table TEXT NOT NULL,  -- 'devedores' | 'cobrancas' | 'processos' | 'crm_lembretes'
  source_id UUID NOT NULL,
  event_type TEXT NOT NULL,    -- 'acordo' | 'vencimento' | 'lembrete' | 'audiencia'
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, google_event_id)
);

CREATE INDEX IF NOT EXISTS idx_cal_sync_source ON public.calendar_events_sync(source_table, source_id);
ALTER TABLE public.calendar_events_sync ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cal_sync_owner_all" ON public.calendar_events_sync FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
