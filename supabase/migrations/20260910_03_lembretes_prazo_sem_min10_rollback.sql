-- ============================================================================
-- ROLLBACK de 20260910_03_lembretes_prazo_sem_min10.sql
-- Restaura lembretes_agendar_avisos() exatamente como em 20260905_lembretes.sql
-- (3 fases para qualquer origem, texto único). Avisos já enfileirados não são
-- tocados; um UPDATE posterior no lembrete os recria pela regra antiga.
-- ============================================================================

begin;

CREATE OR REPLACE FUNCTION public.lembretes_agendar_avisos()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  corpo    text;
  v_d1     timestamptz;
  v_dia    timestamptz;
  v_min10  timestamptz;
  v_quando text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.data_hora = OLD.data_hora
     AND NEW.status = OLD.status
     AND NEW.telefone_notificacao IS NOT DISTINCT FROM OLD.telefone_notificacao
     AND NEW.titulo IS NOT DISTINCT FROM OLD.titulo
     AND NEW.descricao IS NOT DISTINCT FROM OLD.descricao
     AND NEW.numero_processo IS NOT DISTINCT FROM OLD.numero_processo THEN
    RETURN NEW;
  END IF;

  UPDATE public.crm_mensagens_agendadas
    SET status = 'cancelada'
    WHERE lembrete_id = NEW.id AND status = 'pendente';

  IF NEW.status <> 'agendado' THEN
    RETURN NEW;
  END IF;

  v_quando := to_char(NEW.data_hora AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY às HH24:MI');
  corpo := '*' || NEW.titulo || '*'
        || CASE WHEN coalesce(NEW.descricao,'') <> '' THEN E'\n' || NEW.descricao ELSE '' END
        || CASE WHEN coalesce(NEW.numero_processo,'') <> '' THEN E'\nProcesso: ' || NEW.numero_processo ELSE '' END
        || E'\nQuando: ' || v_quando;

  v_d1    := (((NEW.data_hora AT TIME ZONE 'America/Sao_Paulo')::date - 1) + time '19:00') AT TIME ZONE 'America/Sao_Paulo';
  v_dia   := ((NEW.data_hora AT TIME ZONE 'America/Sao_Paulo')::date + time '08:00') AT TIME ZONE 'America/Sao_Paulo';
  v_min10 := NEW.data_hora - interval '10 minutes';

  INSERT INTO public.crm_mensagens_agendadas
    (lembrete_id, telefone, tipo, mensagem, agendada_para, status, origem, operador_id)
  SELECT NEW.id, NEW.telefone_notificacao, 'texto', msg, quando, 'pendente',
         'lembrete_aviso_' || fase, auth.uid()
  FROM (VALUES
    ('d1',    v_d1,    '📌 *Lembrete para amanhã*' || E'\n' || corpo),
    ('dia',   v_dia,   '📌 *Lembrete de hoje*'     || E'\n' || corpo),
    ('min10', v_min10, '⏰ *Em 10 minutos*'         || E'\n' || corpo)
  ) AS f(fase, quando, msg)
  WHERE quando > now();

  RETURN NEW;
END;
$$;

commit;
