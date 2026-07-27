-- Rollback de 2026-07-27_rf_cnpj_socios.sql
-- Remove a RPC e as tabelas da base pública de CNPJ da Receita Federal.
-- (Não remove as extensões unaccent/pg_trgm — podem ser usadas por outros objetos.)

drop function if exists public.buscar_empresas_por_socio(text, text);

drop table if exists public.rf_socios;
drop table if exists public.rf_estabelecimentos;
drop table if exists public.rf_empresas;

-- f_unaccent pode ser usada por índices de outras tabelas; só remova se tiver certeza:
-- drop function if exists public.f_unaccent(text);
