-- ============================================================================
-- proc_intimacoes — suporte a fonte 'datajud' + dedup idempotente
-- ----------------------------------------------------------------------------
-- Contexto: o cron api/cron-datajud.js puxa andamentos da API pública do DataJud
--   (CNJ) e grava em proc_intimacoes. Duas mudanças aditivas:
--   1) O CHECK de `fonte` (criado em 20260510_06_intimacoes.sql) NÃO incluía
--      'datajud' — apesar de a edge function/escavador citarem essa fonte. Aqui
--      corrigimos o drift adicionando 'datajud'.
--   2) Nova coluna `dedup_key` + UNIQUE index para o insert idempotente do cron
--      (ON CONFLICT (dedup_key) DO NOTHING). NULLs são permitidos múltiplas vezes
--      (Postgres trata NULL como distinto), então fontes sem chave (escavador/
--      manual) seguem inalteradas.
-- ----------------------------------------------------------------------------
-- Aditivo e reversível. NÃO rodar `supabase db push` cego (ver CLAUDE.md):
--   aplicar via Supabase MCP/SQL Editor no projeto jokbxzhcctcwnbhkhgru após
--   review. Rollback pareado: 2026-06-23a_intimacoes_datajud_rollback.sql
-- ============================================================================

-- 1) Amplia o domínio de `fonte` para incluir 'datajud'
ALTER TABLE public.proc_intimacoes DROP CONSTRAINT IF EXISTS proc_intimacoes_fonte_check;
ALTER TABLE public.proc_intimacoes
  ADD CONSTRAINT proc_intimacoes_fonte_check
  CHECK (fonte IN ('escavador','jusbrasil','codilo','datajud','manual'));

-- 2) Chave de deduplicação para o cron DataJud (idempotência)
ALTER TABLE public.proc_intimacoes ADD COLUMN IF NOT EXISTS dedup_key TEXT;
COMMENT ON COLUMN public.proc_intimacoes.dedup_key IS
  'Chave estável do andamento (`<digitos>:<codigoMov>:<dataHora>`) p/ insert idempotente do cron DataJud. NULL para fontes sem chave (escavador/manual).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_intimacoes_dedup
  ON public.proc_intimacoes(dedup_key);
