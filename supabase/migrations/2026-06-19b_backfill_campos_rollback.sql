-- ============================================================================
-- ROLLBACK de 2026-06-19b_backfill_campos.sql
-- Re-anula as colunas que o backfill copiou. NÃO há perda: os valores seguem
-- vivos em metadata/divida (o backfill só copiou). Rodar ANTES da Etapa D
-- começar a escrever nessas colunas pelo cliente (senão re-anula dado novo).
-- ============================================================================

UPDATE public.cobrancas SET
  numero_processo = NULL,
  vara_tribunal   = NULL,
  vencimento      = NULL,
  tipo_documento  = NULL,
  observacoes     = NULL,
  tags            = '{}';

UPDATE public.devedores SET
  data_nascimento = NULL,
  observacoes     = NULL,
  tags            = '{}';
