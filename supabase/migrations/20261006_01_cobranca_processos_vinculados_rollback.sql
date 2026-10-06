-- Rollback de 20261006_01_cobranca_processos_vinculados.sql
-- Apaga a tabela e o que foi cadastrado nela. O metadata.processosRelacionados
-- original nunca foi alterado, então nada se perde da migração do Astrea.
begin;
drop table if exists public.cobranca_processos_vinculados;
commit;
