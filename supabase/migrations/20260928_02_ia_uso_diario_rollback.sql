-- Rollback de 20260928_02_ia_uso_diario.sql
-- Antes de rodar: reverter o api/claude.js (sem a RPC o proxy nega o colaborador, fail-closed).
drop function if exists public.ia_uso_registrar(uuid, integer);
drop table if exists public.ia_uso_diario;
alter table public.app_users drop column if exists ia_limite_dia;
