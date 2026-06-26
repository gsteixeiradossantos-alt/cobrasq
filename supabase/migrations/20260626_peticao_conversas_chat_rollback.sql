-- Rollback de 20260626_peticao_conversas_chat.sql.
-- NÃO remove a tabela peticao_conversas (é anterior, de 2026-05-11j) nem RLS/trigger.
-- Só desfaz as colunas/constraint/índice/default acrescentados pela extensão do chat.

ALTER TABLE public.peticao_conversas DROP CONSTRAINT IF EXISTS peticao_conversas_status_chk;
DROP INDEX IF EXISTS public.idx_peticao_conversas_status;
ALTER TABLE public.peticao_conversas ALTER COLUMN owner_id DROP DEFAULT;

ALTER TABLE public.peticao_conversas
  DROP COLUMN IF EXISTS caso_id,
  DROP COLUMN IF EXISTS credor_id,
  DROP COLUMN IF EXISTS tipo,
  DROP COLUMN IF EXISTS titulo,
  DROP COLUMN IF EXISTS peca_html,
  DROP COLUMN IF EXISTS calc,
  DROP COLUMN IF EXISTS status;
