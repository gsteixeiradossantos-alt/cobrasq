-- JÁ APLICADO EM PROD (versão 20260727032942). Snapshot reconstruído do catálogo em 2026-07-29. NÃO rodar db push.
-- ============================================================================
-- Carlos (IA de negociação inicial, fase "a cobrar" — distinto da Bia): flag
-- por cobrança indicando que o Carlos está ativo no caso. Ligado/desligado
-- pelo botão no index.html.
-- ============================================================================

ALTER TABLE public.cobrancas
  ADD COLUMN IF NOT EXISTS carlos_ativo boolean NOT NULL DEFAULT false;
