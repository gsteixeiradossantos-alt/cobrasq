-- Rollback de 20260703_pendentes_desfecho.sql
DROP INDEX IF EXISTS public.idx_wa_atend_regua_bloqueada;
DROP INDEX IF EXISTS public.idx_wa_atend_resolvido;

ALTER TABLE public.whatsapp_atendimentos
  DROP COLUMN IF EXISTS resolvido_por,
  DROP COLUMN IF EXISTS resolvido_em,
  DROP COLUMN IF EXISTS regua_bloqueada,
  DROP COLUMN IF EXISTS motivo,
  DROP COLUMN IF EXISTS desfecho;
