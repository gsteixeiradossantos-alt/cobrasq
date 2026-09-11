-- ============================================================================
-- Lembretes do tipo PRAZO: sem o aviso "Em 10 minutos" e com texto próprio.
--
-- NÃO APLICADA EM PRODUÇÃO (aguardando autorização). Rollback pareado em
-- 20260910_03_lembretes_prazo_sem_min10_rollback.sql.
--
-- POR QUÊ. Decisão do gestor em 10/09/2026: todo compromisso do escritório
-- passa a avisar no WhatsApp — inclusive os prazos processuais ("Cumprir
-- prazo"), que até então só existiam na Google Agenda, sem aviso nenhum.
-- Prazo não tem hora marcada: é gravado às 08:00 do dia fatal. Com as três
-- fases de hoje, o terceiro aviso ("⏰ Em 10 minutos", às 07:50) chegaria dez
-- minutos ANTES do segundo (08:00) dizendo a mesma coisa. Para prazo fica
-- véspera 19h + dia 08h.
--
-- O QUE MUDA em lembretes_agendar_avisos()
--   1. origem = 'prazo' não gera a fase min10.
--   2. Texto por tipo: prazo abre com "Prazo vence amanhã/hoje" e fecha com
--      "Prazo fatal: dd/mm/aaaa" — sem o "às 08:00", que faria parecer um
--      compromisso com hora. Os demais tipos mantêm o texto de sempre.
--   3. `origem` entra na lista de colunas cuja mudança recria os avisos.
--      Antes, um UPDATE só de origem não recalculava nada — e agora a origem
--      decide quantas fases existem.
--
-- O QUE NÃO MUDA. Tabela, RLS, FK, as fases d1/dia, o cancelamento dos
-- pendentes antes de recriar, o "fase no passado não é criada" e
-- operador_id = auth.uid() (R-18). A tela (index.html, salvarLembrete) segue
-- gravando origem 'manual' e não envia `origem` no update; prazos nascem pela
-- skill (lembretes-cobrasq / analise-prazos-lote).
--
-- VERIFICAÇÃO (R-18). Dry-run em produção dentro de begin/rollback: função
-- substituída na transação, INSERT como gestor (JWT simulado) com origem
-- 'prazo' e com origem 'manual', INSERT como colaborador (deve falhar por
-- RLS), contagem das fases geradas — nada persiste. Números no PR.
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
  v_prazo  boolean;
  cab_d1   text;
  cab_dia  text;
BEGIN
  -- Update que não mexeu em nada relevante para o aviso: não recalcula.
  IF TG_OP = 'UPDATE'
     AND NEW.data_hora = OLD.data_hora
     AND NEW.status = OLD.status
     AND NEW.telefone_notificacao IS NOT DISTINCT FROM OLD.telefone_notificacao
     AND NEW.titulo IS NOT DISTINCT FROM OLD.titulo
     AND NEW.descricao IS NOT DISTINCT FROM OLD.descricao
     AND NEW.numero_processo IS NOT DISTINCT FROM OLD.numero_processo
     AND NEW.origem IS NOT DISTINCT FROM OLD.origem THEN
    RETURN NEW;
  END IF;

  -- Sempre cancela os pendentes antes de recriar (idempotente).
  UPDATE public.crm_mensagens_agendadas
    SET status = 'cancelada'
    WHERE lembrete_id = NEW.id AND status = 'pendente';

  IF NEW.status <> 'agendado' THEN
    RETURN NEW; -- concluído/cancelado: só cancela, não recria.
  END IF;

  v_prazo := (NEW.origem = 'prazo');

  IF v_prazo THEN
    -- Prazo: a hora gravada (08:00) é convenção, não compromisso.
    v_quando := 'Prazo fatal: ' || to_char(NEW.data_hora AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY');
    cab_d1   := '⚠️ *Prazo vence amanhã*';
    cab_dia  := '⚠️ *Prazo vence hoje*';
  ELSE
    v_quando := 'Quando: ' || to_char(NEW.data_hora AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY às HH24:MI');
    cab_d1   := '📌 *Lembrete para amanhã*';
    cab_dia  := '📌 *Lembrete de hoje*';
  END IF;

  corpo := '*' || NEW.titulo || '*'
        || CASE WHEN coalesce(NEW.descricao,'') <> '' THEN E'\n' || NEW.descricao ELSE '' END
        || CASE WHEN coalesce(NEW.numero_processo,'') <> '' THEN E'\nProcesso: ' || NEW.numero_processo ELSE '' END
        || E'\n' || v_quando;

  v_d1    := (((NEW.data_hora AT TIME ZONE 'America/Sao_Paulo')::date - 1) + time '19:00') AT TIME ZONE 'America/Sao_Paulo';
  v_dia   := ((NEW.data_hora AT TIME ZONE 'America/Sao_Paulo')::date + time '08:00') AT TIME ZONE 'America/Sao_Paulo';
  v_min10 := NEW.data_hora - interval '10 minutes';

  -- operador_id = auth.uid(): exigido pela policy msg_agendada_insert_owner
  -- quando quem grava é a tela (R-18). Em service_role fica NULL, inofensivo.
  INSERT INTO public.crm_mensagens_agendadas
    (lembrete_id, telefone, tipo, mensagem, agendada_para, status, origem, operador_id)
  SELECT NEW.id, NEW.telefone_notificacao, 'texto', msg, quando, 'pendente',
         'lembrete_aviso_' || fase, auth.uid()
  FROM (VALUES
    ('d1',    v_d1,    cab_d1 || E'\n' || corpo),
    ('dia',   v_dia,   cab_dia || E'\n' || corpo),
    ('min10', v_min10, '⏰ *Em 10 minutos*' || E'\n' || corpo)
  ) AS f(fase, quando, msg)
  WHERE quando > now()                       -- não agenda aviso no passado
    AND NOT (v_prazo AND fase = 'min10');    -- prazo não tem "em 10 minutos"

  RETURN NEW;
END;
$$;

-- O trigger trg_lembretes_agendar_avisos já aponta para esta função; não
-- precisa ser recriado.

commit;
