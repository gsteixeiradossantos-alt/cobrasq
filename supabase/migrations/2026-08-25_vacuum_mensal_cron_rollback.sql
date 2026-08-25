-- Rollback de 2026-08-25_vacuum_mensal_cron: remove o agendamento do pg_cron.

select cron.unschedule('vacuum-mensal');
