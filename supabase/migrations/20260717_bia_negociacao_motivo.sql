-- JÁ APLICADO EM PROD (versão 20260717233839). Snapshot reconstruído do catálogo em 2026-07-29. NÃO rodar db push.
-- ============================================================================
-- Bia Cobrança: motivo alegado pelo devedor na negociação — registrado no
-- pedido de aprovação (bia_aprovacoes.motivo) e no adiamento da cobrança
-- (bia_cobranca.motivo_adiamento).
-- TODO conferir: a atribuição de AMBAS as colunas a esta migração é inferida
-- pela ordem física no catálogo (motivo logo após resultado em bia_aprovacoes;
-- motivo_adiamento como última coluna de bia_cobranca) e pela semântica do
-- nome da versão.
-- ============================================================================

ALTER TABLE public.bia_aprovacoes
  ADD COLUMN IF NOT EXISTS motivo text;

ALTER TABLE public.bia_cobranca
  ADD COLUMN IF NOT EXISTS motivo_adiamento text;
