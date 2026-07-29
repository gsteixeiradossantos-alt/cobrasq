-- JÁ APLICADO EM PROD (versão 20260717200639). Snapshot reconstruído do catálogo em 2026-07-29. NÃO rodar db push.
-- ============================================================================
-- Bia Cobrança · Fase 1: log de lembretes enviados (auditoria do que a Bia
-- mandou, para qual telefone e em que sequência). Grants = defaults do schema;
-- trava real é a RLS owner-only.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.bia_cobranca_log (
  id               bigserial PRIMARY KEY,
  asaas_payment_id text,
  telefone         text,
  lembrete_num     integer,
  texto            text,
  enviada_em       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bia_cobranca_log_pay ON public.bia_cobranca_log USING btree (asaas_payment_id);

ALTER TABLE public.bia_cobranca_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bia_cobranca_log_owner_all ON public.bia_cobranca_log;
CREATE POLICY bia_cobranca_log_owner_all ON public.bia_cobranca_log
  FOR ALL
  USING (current_user_papel() = 'proprietario')
  WITH CHECK (current_user_papel() = 'proprietario');
