-- 2026-08-25_vacuum_mensal_cron
--
-- Agenda um VACUUM (ANALYZE) mensal via pg_cron (extensão já habilitada no
-- projeto, schema pg_catalog — ver `select * from pg_extension where extname
-- = 'pg_cron'`). Todo dia 1 às 03:00 UTC (00h em Brasília), fora do horário
-- de uso do painel.
--
-- VACUUM simples (sem FULL): não bloqueia leitura/escrita concorrente, só
-- recicla espaço morto (tuplas mortas) e atualiza as estatísticas do
-- planner. O autovacuum já roda continuamente por tabela; isso é só um
-- reforço periódico, não substitui nem desliga o autovacuum.
--
-- Idempotente: cron.schedule com o mesmo job_name (upsert) substitui o
-- agendamento anterior, então reaplicar essa migração não duplica o job.
-- Rollback: 2026-08-25_vacuum_mensal_cron_rollback.sql (cron.unschedule).

select cron.schedule(
  'vacuum-mensal',
  '0 3 1 * *',
  $$vacuum (analyze)$$
);
