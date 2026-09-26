-- Rollback de 20260926_03: remove a versão com p_cobranca_id e volta à de
-- 5 parâmetros (cobrança escolhida pelo próprio banco).
drop function if exists public.iniciar_investigacao_patrimonial(uuid,text,text,smallint,integer,uuid);
-- Em seguida reaplicar o bloco "create or replace function
-- public.iniciar_investigacao_patrimonial" + revoke/grant de
-- supabase/migrations/20260926_01_investigacao_cobranca_id.sql.
