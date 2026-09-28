-- Categorias próprias para títulos: 'cheque', 'duplicata' e 'boleto' em documentos.
-- Até aqui cheque, duplicata e boleto mandados pelo cliente só cabiam em
-- "Nota promissória" ou "Outros" (vistoria Bidão, 28/09/2026). O painel passa a
-- oferecê-las em DOC_CATEGORIAS (index.html), inclusive na aba Portal do cliente.
alter table public.documentos drop constraint if exists documentos_categoria_check;
alter table public.documentos add constraint documentos_categoria_check
  check (categoria = any (array['contrato','nota-promissoria','cheque','duplicata','boleto','comprovante','repasse','acordo-assinado','peticao','procuracao','calculo','devolucao-documento','outros']));
