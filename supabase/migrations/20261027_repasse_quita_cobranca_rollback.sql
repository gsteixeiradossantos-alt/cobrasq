-- Rollback de 20261027_repasse_quita_cobranca.sql
-- Volta a regra a existir só no painel. Status já alterados pelo trigger ficam como estão.
drop trigger if exists trg_repasses_cliente_quitar_cobranca on public.repasses_cliente;
drop function if exists public.repasses_cliente_quitar_cobranca();
