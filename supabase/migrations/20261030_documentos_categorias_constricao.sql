-- ============================================================================
-- Categorias novas em documentos (pedido do Gustavo em 30/10/2026)
--
-- Comprovantes de atos de constrição e negativação passam a ter categoria própria
-- na aba "Documentos do caso", em vez de cair em "comprovante" ou "outros":
--   protesto            — pedido/instrumento de protesto (Cenprot, cartório)
--   penhora-imovel      — termo/auto de penhora de imóvel
--   averbacao-veiculo   — averbação/restrição de veículo (Renajud, art. 828 CPC)
--   averbacao-imovel    — averbação na matrícula (art. 828 CPC)
--   spc                 — inclusão no SPC
-- Primeiro caso: comprovante do pedido de protesto nº 3954400 (cobrança
-- ce346cee-8bf1-4a4e-a719-ffbc5951e893, processo 0000286-43.2022.8.16.0209).
--
-- Aditiva (só amplia o check). Rollback pareado.
-- ============================================================================

begin;

alter table public.documentos drop constraint if exists documentos_categoria_check;
alter table public.documentos add constraint documentos_categoria_check
  check (categoria = any (array['contrato','nota-promissoria','cheque','duplicata','boleto','comprovante','repasse','acordo-assinado','peticao','procuracao','calculo','devolucao-documento','matricula','protesto','penhora-imovel','averbacao-veiculo','averbacao-imovel','spc','outros']));

commit;
