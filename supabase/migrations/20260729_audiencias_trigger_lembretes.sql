-- ============================================================
-- Fix: 3 audiências de 29/07 cadastradas pela skill audiencias-cobrasq
-- (INSERT direto em public.audiencias) não geraram lembrete nenhum, porque
-- o agendamento dos 3 lembretes de WhatsApp só existia em JS no front-end
-- (chamado só pelo formulário "Nova audiência" da UI). Qualquer outro
-- caminho de inserção (skill, import em lote, SQL direto) ficava sem aviso.
--
-- Fix: move o agendamento para um trigger no banco, que dispara em
-- QUALQUER INSERT/UPDATE em `audiencias`, independente da origem.
-- Também normaliza o campo partes[].papel: a UI grava "AUTOR"/"REU"
-- (maiúsculo sem acento), mas a skill audiencias-cobrasq grava
-- "Autor"/"Réu" — a comparação agora ignora caixa e acento.
-- ============================================================

CREATE OR REPLACE FUNCTION public.audiencias_agendar_lembretes()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reus text;
  rodape text;
  v_d1 timestamptz;
  v_dia timestamptz;
  v_min10 timestamptz;
BEGIN
  -- Update que não mexeu em nada relevante: não recalcula.
  IF TG_OP = 'UPDATE'
     AND NEW.data_hora = OLD.data_hora
     AND NEW.status = OLD.status
     AND NEW.telefone_notificacao IS NOT DISTINCT FROM OLD.telefone_notificacao THEN
    RETURN NEW;
  END IF;

  -- Sempre cancela os lembretes pendentes antigos antes de recriar (idempotente).
  UPDATE public.crm_mensagens_agendadas
    SET status = 'cancelada'
    WHERE audiencia_id = NEW.id AND status = 'pendente';

  IF NEW.status <> 'agendada' THEN
    RETURN NEW; -- cancelada/realizada/remarcada: só cancela, não recria.
  END IF;

  SELECT string_agg(p->>'nome', ', ') INTO reus
    FROM jsonb_array_elements(NEW.partes) p
    WHERE replace(upper(p->>'papel'), 'É', 'E') = 'REU';
  rodape := 'Processo: ' || NEW.numero_processo || E'\n'
            || coalesce(NEW.comarca,'') || ', sala: ' || coalesce(NEW.sala,'—') || E'\n'
            || 'Réu(s): ' || coalesce(reus,'—');

  v_d1    := (((NEW.data_hora AT TIME ZONE 'America/Sao_Paulo')::date - 1) + time '19:00') AT TIME ZONE 'America/Sao_Paulo';
  v_dia   := ((NEW.data_hora AT TIME ZONE 'America/Sao_Paulo')::date + time '08:00') AT TIME ZONE 'America/Sao_Paulo';
  v_min10 := NEW.data_hora - interval '10 minutes';

  INSERT INTO public.crm_mensagens_agendadas (audiencia_id, telefone, tipo, mensagem, agendada_para, status, origem)
  SELECT NEW.id, NEW.telefone_notificacao, 'texto', msg, quando, 'pendente', 'audiencia_lembrete_' || fase
  FROM (VALUES
    ('d1',    v_d1,    '🔔 *Lembrete — audiência amanhã*' || E'\n' || rodape || E'\nData: ' || to_char(NEW.data_hora AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY às HH24:MI')),
    ('dia',   v_dia,   '📅 *Hoje tem audiência*' || E'\n' || rodape || E'\nÀs ' || to_char(NEW.data_hora AT TIME ZONE 'America/Sao_Paulo','HH24:MI')),
    ('min10', v_min10, '⏰ *Audiência em 10 minutos*' || E'\n' || rodape || E'\nÀs ' || to_char(NEW.data_hora AT TIME ZONE 'America/Sao_Paulo','HH24:MI'))
  ) AS f(fase, quando, msg)
  WHERE quando > now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audiencias_agendar_lembretes ON public.audiencias;
CREATE TRIGGER trg_audiencias_agendar_lembretes
  AFTER INSERT OR UPDATE ON public.audiencias
  FOR EACH ROW EXECUTE FUNCTION public.audiencias_agendar_lembretes();
