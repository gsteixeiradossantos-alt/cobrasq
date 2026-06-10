-- PR-G: campo obrigatório "tipo de cobrança" em devedores.
--
-- Significado (definido pelo gestor):
-- - 'fisica':  documentação está no escritório presencialmente (cheque,
--              contrato em papel, boletos físicos, etc.).
-- - 'digital': documentação foi enviada/recebida via WhatsApp pelo credor.
--
-- Plano:
-- 1) Adiciona coluna NULLABLE com CHECK constraint.
-- 2) Backfill: todos os cadastros existentes não-arquivados ← 'digital'
--    (decisão do gestor em 10/06/2026; ele revisa caso por caso depois).
-- 3) ALTER SET NOT NULL → toda nova cobrança é obrigada a escolher.

ALTER TABLE public.devedores
  ADD COLUMN IF NOT EXISTS tipo_cobranca text
  CHECK (tipo_cobranca IN ('fisica','digital'));

-- Backfill (idempotente: só atualiza onde ainda é NULL).
UPDATE public.devedores
SET tipo_cobranca = 'digital'
WHERE tipo_cobranca IS NULL;

ALTER TABLE public.devedores
  ALTER COLUMN tipo_cobranca SET NOT NULL,
  ALTER COLUMN tipo_cobranca SET DEFAULT 'digital';

COMMENT ON COLUMN public.devedores.tipo_cobranca IS
  'fisica = documentação no escritório; digital = recebida via WhatsApp do credor.';
