-- Rollback de 20261030_documentos_categorias_constricao.sql.
-- Falha se já houver documento numa das categorias novas: reclassificar antes.
begin;

alter table public.documentos drop constraint if exists documentos_categoria_check;
alter table public.documentos add constraint documentos_categoria_check
  check (categoria = any (array['contrato','nota-promissoria','cheque','duplicata','boleto','comprovante','repasse','acordo-assinado','peticao','procuracao','calculo','devolucao-documento','matricula','outros']));

commit;
