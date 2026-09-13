-- ROLLBACK de 20260913_01_intimacoes_agenda_pendente.sql (só leitura; nada a desfazer em dados)
begin;
DROP VIEW IF EXISTS public.vw_intimacoes_agenda_pendente;
DROP FUNCTION IF EXISTS public.intimacao_parse_audiencia(text, text);
DROP FUNCTION IF EXISTS public.somar_dias_uteis(date, int);
DROP FUNCTION IF EXISTS public.dia_util_forense(date);
commit;
