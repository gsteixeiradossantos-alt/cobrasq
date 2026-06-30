-- Permite a categoria 'repasse' em documentos (aba "Repasses ao cliente").
-- Sem isto, o INSERT do comprovante de repasse violava o CHECK e o PDF não anexava.
-- Aplicada em prod via apply_migration em 2026-06-30.
alter table public.documentos drop constraint if exists documentos_categoria_check;
alter table public.documentos add constraint documentos_categoria_check
  check (categoria = any (array['contrato','nota-promissoria','comprovante','repasse','acordo-assinado','peticao','procuracao','calculo','outros']));
