-- Rollback de 20260910_02_cobr_sinais_pendencia.sql
-- Seguro a qualquer momento: o cliente cai sozinho no caminho antigo (as 11
-- requisições) quando a função não existe.
drop function if exists public.cobr_sinais_pendencia();
