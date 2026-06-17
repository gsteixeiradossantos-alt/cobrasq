-- PR1 (faturamento → automação Asaas): persistir o ID do customer Asaas no devedor.
--
-- Motivo: hoje o asaasCustomerId só vive no DB local (localStorage) do index.html.
-- Sem ele no banco, webhooks/edge functions não conseguem casar um pagamento Asaas
-- (que traz `payment.customer = cus_...`) com o devedor. Esta coluna é a fonte
-- canônica server-side do vínculo.
--
-- Notas:
-- - 1 customer Asaas por devedor (UNIQUE parcial; ignora vazios/nulos).
-- - O match por CPF na hora de criar/buscar o customer reutiliza a coluna gerada
--   `doc_digits` já existente (idx_devedores_doc_digits_unique).
-- - Backfill: feito de forma incremental por `asaasEnsureCustomer` (grava ao
--   emitir/garantir o customer) e em massa pela futura aba "Importação" (PR8).

ALTER TABLE public.devedores
  ADD COLUMN IF NOT EXISTS asaas_customer_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_devedores_asaas_customer_id
  ON public.devedores(asaas_customer_id)
  WHERE asaas_customer_id IS NOT NULL AND asaas_customer_id <> '';

COMMENT ON COLUMN public.devedores.asaas_customer_id IS
  'ID do customer no Asaas (cus_...). Gravado por asaasEnsureCustomer e usado pelo '
  'asaas-webhook para casar pagamentos recebidos ao devedor.';
