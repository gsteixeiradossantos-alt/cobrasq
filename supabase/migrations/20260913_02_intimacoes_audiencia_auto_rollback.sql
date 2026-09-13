-- ============================================================================
-- ROLLBACK de 20260913_02_intimacoes_audiencia_auto.sql
-- Remove triggers/funções de audiência e a sobrecarga de 8 parâmetros de
-- intimacao_criar_lembrete (a de 7 volta a ser a versão da 20260913_01).
-- Audiências criadas (created_by 'auto: intimação …') ficam; para apagar:
--   delete from public.audiencias where created_by like 'auto: intimação%';
-- ============================================================================
begin;
DROP TRIGGER IF EXISTS trg_intim_audiencia_email ON public.intimacoes_email;
DROP TRIGGER IF EXISTS trg_intim_audiencia_djen ON public.intimacoes_djen;
DROP FUNCTION IF EXISTS public.trg_intim_audiencia_email();
DROP FUNCTION IF EXISTS public.trg_intim_audiencia_djen();
DROP FUNCTION IF EXISTS public.intimacao_agendar_audiencia(text, text, uuid, date, text, text, text);
DROP FUNCTION IF EXISTS public.intimacao_parse_audiencia(text, text);
DROP FUNCTION IF EXISTS public.intimacao_criar_lembrete(text, text, uuid, date, text, text, text);
DROP FUNCTION IF EXISTS public.intimacao_criar_lembrete(text, text, uuid, date, text, text, text, boolean);
CREATE OR REPLACE FUNCTION public.intimacao_criar_lembrete(
  p_tribunal text, p_numero text, p_cobranca uuid, p_data date, p_ato text, p_fonte text, p_link text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conferir date;
  v_fatal    date;
  v_id       uuid;
  v_cobr     uuid;
BEGIN
  IF p_tribunal IS NULL OR p_tribunal = 'TJPR' OR p_data IS NULL THEN RETURN NULL; END IF;

  -- Já tem conferência agendada para este processo nos últimos 10 dias? Não repete.
  IF p_numero IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.lembretes l
        WHERE l.numero_processo = p_numero
          AND l.created_by LIKE 'auto: intimação%'
          AND l.created_at > now() - interval '10 days'
     ) THEN
    RETURN NULL;
  END IF;

  -- Conferir no próximo dia útil (se a intimação é de hoje ou do passado, amanhã útil).
  v_conferir := public.somar_dias_uteis(greatest(p_data, current_date), 1);
  -- Estimativa art. 224 CPC: publicação = 1º dia útil após a disponibilização;
  -- o prazo começa no dia útil seguinte e corre 15 dias úteis.
  v_fatal := public.somar_dias_uteis(public.somar_dias_uteis(p_data, 1), 15);

  -- FK: só grava cobranca_id se a cobrança existe.
  SELECT id INTO v_cobr FROM public.cobrancas WHERE id = p_cobranca;

  INSERT INTO public.lembretes
    (titulo, descricao, data_hora, numero_processo, cobranca_id, telefone_notificacao, status, origem, created_by)
  VALUES (
    left('Conferir intimação ' || coalesce(p_numero, '(sem número)') || ' — ' || coalesce(p_ato, 'intimação'), 180),
    p_tribunal || ' · intimação de ' || to_char(p_data, 'DD/MM/YYYY') || ' (' || p_fonte || ').'
      || E'\nPrazo ESTIMADO (15 dias úteis): ' || to_char(v_fatal, 'DD/MM/YYYY')
      || ' — abrir o sistema, confirmar o prazo real e fixar pela skill lembretes-cobrasq.'
      || CASE WHEN p_link IS NOT NULL THEN E'\n' || p_link ELSE '' END,
    ((v_conferir + time '08:00') AT TIME ZONE 'America/Sao_Paulo'),
    p_numero, v_cobr,
    '46999223332',                -- número do escritório (mesmo da skill lembretes-cobrasq)
    'agendado', 'manual',
    'auto: intimação ' || p_fonte
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.intimacao_criar_lembrete(text, text, uuid, date, text, text, text) FROM PUBLIC, anon, authenticated;
commit;
