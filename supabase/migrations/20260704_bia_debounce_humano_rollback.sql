-- Rollback de 20260704_bia_debounce_humano.sql
DROP TABLE IF EXISTS public.whatsapp_bia_enviadas;

ALTER TABLE public.whatsapp_bia_config
  DROP COLUMN IF EXISTS humano_pausa_min,
  DROP COLUMN IF EXISTS debounce_seg;

ALTER TABLE public.whatsapp_atendimentos
  DROP COLUMN IF EXISTS humano_ate;
