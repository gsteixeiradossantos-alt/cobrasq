-- Rollback de 20261005_01_rotinas_mac_avisos.sql
begin;
select cron.unschedule('rotinas-mac-conferir') where exists (select 1 from cron.job where jobname = 'rotinas-mac-conferir');
drop function if exists public.rotinas_mac_conferir(boolean);
alter table public.vigia_acoes drop column if exists avisado_em;
drop table if exists public.rotinas_execucoes;
commit;
