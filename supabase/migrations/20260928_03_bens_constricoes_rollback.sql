-- Rollback de 20260928_03_bens_constricoes.sql.
-- Apaga as duas tabelas (e os registros) e tira a categoria 'matricula'.
-- Antes: documentos com categoria 'matricula' viram 'outros', senão o CHECK falha.
begin;
drop table if exists public.bens_constricoes;
drop table if exists public.bens_cobranca;
update public.documentos set categoria='outros' where categoria='matricula';
alter table public.documentos drop constraint if exists documentos_categoria_check;
alter table public.documentos add constraint documentos_categoria_check
  check (categoria = any (array['contrato','nota-promissoria','cheque','duplicata','boleto','comprovante','repasse','acordo-assinado','peticao','procuracao','calculo','devolucao-documento','outros']));
commit;
