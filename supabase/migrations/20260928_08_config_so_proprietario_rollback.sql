-- Rollback de 20260928_08_config_so_proprietario.sql
drop trigger if exists trg_cobrasq_data_config_dono on public.cobrasq_data;
drop function if exists public.fn_cobrasq_data_config_dono();
