-- JÁ APLICADO EM PROD (versão 20260717122611). Snapshot reconstruído do catálogo em 2026-07-29. NÃO rodar db push.
-- ============================================================================
-- Modo de teste da Bia (atendimento): quando preenchido, a Bia só responde a
-- este telefone. NOTA: "bia_config" no nome da migração de prod refere-se à
-- tabela public.whatsapp_bia_config (singleton id=1, criada em
-- 20260702_bia_atendimento.sql) — não existe tabela "bia_config" no catálogo.
-- ============================================================================

ALTER TABLE public.whatsapp_bia_config
  ADD COLUMN IF NOT EXISTS teste_telefone text;
