-- Rollback de 20261016b_portal_solicitacoes.sql
drop function if exists public.cedente_nova_duvida(text,text);
drop function if exists public.cedente_nova_solicitacao(text,text,text,text,numeric,date,text,text);
drop table if exists public.portal_solicitacoes;
drop function if exists public.portal_meus_clientes();
