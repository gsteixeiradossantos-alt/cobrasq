-- Permite a categoria 'devolucao-documento' em documentos (anexo de devolução de
-- documento/cheque ao devedor). Sem isto, o INSERT do anexo viola o CHECK.
alter table public.documentos drop constraint if exists documentos_categoria_check;
alter table public.documentos add constraint documentos_categoria_check
  check (categoria = any (array['contrato','nota-promissoria','comprovante','repasse','acordo-assinado','peticao','procuracao','calculo','devolucao-documento','outros']));
