-- ============================================================================
-- ROLLBACK de 20260913_01_intimacoes_prazo_lembrete.sql
-- Remove triggers e funções. Lembretes já criados ('auto: intimação …') ficam;
-- para apagá-los: delete from public.lembretes where created_by like 'auto: intimação%';
-- ============================================================================
begin;
DROP TRIGGER IF EXISTS trg_intim_email_lembrete ON public.intimacoes_email;
DROP TRIGGER IF EXISTS trg_intim_djen_lembrete ON public.intimacoes_djen;
DROP FUNCTION IF EXISTS public.trg_intim_email_lembrete();
DROP FUNCTION IF EXISTS public.trg_intim_djen_lembrete();
DROP FUNCTION IF EXISTS public.intimacao_criar_lembrete(text, text, uuid, date, text, text, text);
DROP FUNCTION IF EXISTS public.somar_dias_uteis(date, int);
DROP FUNCTION IF EXISTS public.dia_util_forense(date);
commit;
