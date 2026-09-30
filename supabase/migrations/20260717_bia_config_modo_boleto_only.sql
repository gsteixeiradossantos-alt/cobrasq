-- JÁ APLICADO EM PROD (versão 20260717142754). Snapshot reconstruído do catálogo em 2026-07-29. NÃO rodar db push.
-- ============================================================================
-- Modo "boleto only" da Bia: responde apenas pedidos de 2ª via/boleto,
-- escalando o resto para humano. Coluna na config singleton da Bia
-- (public.whatsapp_bia_config — ver nota em 20260717_bia_config_teste_telefone.sql).
-- ============================================================================

ALTER TABLE public.whatsapp_bia_config
  ADD COLUMN IF NOT EXISTS modo_boleto_only boolean NOT NULL DEFAULT false;
