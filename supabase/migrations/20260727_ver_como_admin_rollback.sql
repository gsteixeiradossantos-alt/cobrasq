-- ============================================================================
-- Rollback de 20260727_ver_como_admin.sql — NÃO APLICAR SEM REVISÃO
-- ============================================================================
drop function if exists public.admin_encerrar_ver_como(uuid);
drop function if exists public.admin_emitir_sessao_portal(uuid);
drop table if exists public.ver_como_log;
