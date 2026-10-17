-- ============================================================================
-- ROLLBACK de 20261016c_cobrancas_capital_valor_unico.sql
--
-- Remove o trigger e a função que mantinham valor_orig = valor_capital e
-- devolve o comentário original (nenhum) da coluna valor_orig.
--
-- O BACKFILL NÃO É DESFEITO: as linhas que tiveram valor_capital preenchido a
-- partir de valor_orig continuam com o capital (o valor era o mesmo número;
-- apagá-lo voltaria a deixar cobranças sem base de repasse). Também não volta
-- o valor_orig antigo das linhas divergentes que já tenham sido atualizadas
-- depois da migração — para isso seria preciso um snapshot prévio (ver o
-- passo a passo no PR: guardar o resultado da consulta (B) antes de aplicar).
-- ============================================================================

begin;

drop trigger if exists trg_cobrancas_capital_unico on public.cobrancas;
drop function if exists public.cobrancas_capital_unico();
comment on column public.cobrancas.valor_orig is null;

commit;
