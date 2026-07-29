-- ============================================================================
-- FIX · trigger de lembretes de audiência quebrava a tela
--
-- APLICADA EM PRODUÇÃO em 29/07/2026.
--
-- Roda DEPOIS de 20260729_audiencias_trigger_lembretes.sql (ordem alfabética
-- garante: "audiencias" < "fix"). Aquele arquivo cria a versão com o defeito;
-- este substitui pela corrigida. Reaplicar as migrações em ordem deixa o banco
-- correto — o que NÃO pode é parar no arquivo anterior.
--
-- O DEFEITO. O trigger veio do PR #443 e foi aplicado em produção com o PR
-- ainda aberto. Quebrava criar/editar audiência pela UI:
--
--   ERROR: new row violates row-level security policy
--          for table "crm_mensagens_agendadas"
--   CONTEXT: PL/pgSQL function audiencias_agendar_lembretes() line 35
--
-- CAUSA. O INSERT dos lembretes não preenchia `operador_id`, e a policy
-- msg_agendada_insert_owner exige `operador_id = auth.uid()`. A coluna não tem
-- default, então ficava NULL, o with_check dava NULL e a linha era barrada —
-- derrubando junto o INSERT/UPDATE da própria audiência.
--
-- POR QUE PASSOU NO TESTE. A skill audiencias-cobrasq insere via service_role,
-- que ignora RLS. O caminho testado funcionava; o que quebrava era o da tela.
--
-- CORREÇÕES em relação ao #443
--   1. operador_id = auth.uid() no INSERT (NULL em service_role, inofensivo —
--      RLS não se aplica ali).
--   2. SET search_path = public — a função nasceu sem, que é o advisor
--      function_search_path_mutable. O repo tem a migração
--      harden_function_search_path justamente por essa classe de problema.
--
-- VERIFICADO depois de aplicar, com o JWT do gestor em begin/rollback: UPDATE
-- em audiência agendada passa e os 13 lembretes pendentes seguem de pé.
--
-- ROLLBACK: reaplicar 20260729_audiencias_trigger_lembretes.sql. NÃO
-- recomendado — volta a quebrar "Nova audiência" e a edição na tela.
-- ============================================================================

begin;

CREATE OR REPLACE FUNCTION public.audiencias_agendar_lembretes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
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

  -- Sempre cancela os pendentes antes de recriar (idempotente).
  UPDATE public.crm_mensagens_agendadas
    SET status = 'cancelada'
    WHERE audiencia_id = NEW.id AND status = 'pendente';

  IF NEW.status <> 'agendada' THEN
    RETURN NEW; -- cancelada/realizada/remarcada: só cancela, não recria.
  END IF;

  -- Papel tolerante a "REU"/"Réu" (a UI grava sem acento, a skill com).
  SELECT string_agg(p->>'nome', ', ') INTO reus
    FROM jsonb_array_elements(NEW.partes) p
    WHERE replace(upper(p->>'papel'), 'É', 'E') = 'REU';
  rodape := 'Processo: ' || NEW.numero_processo || E'\n'
            || coalesce(NEW.comarca,'') || ', sala: ' || coalesce(NEW.sala,'—') || E'\n'
            || 'Réu(s): ' || coalesce(reus,'—');

  v_d1    := (((NEW.data_hora AT TIME ZONE 'America/Sao_Paulo')::date - 1) + time '19:00') AT TIME ZONE 'America/Sao_Paulo';
  v_dia   := ((NEW.data_hora AT TIME ZONE 'America/Sao_Paulo')::date + time '08:00') AT TIME ZONE 'America/Sao_Paulo';
  v_min10 := NEW.data_hora - interval '10 minutes';

  -- operador_id: é ISTO que faltava. Sem ele a policy msg_agendada_insert_owner
  -- barra a linha e derruba o INSERT/UPDATE da audiência inteira.
  INSERT INTO public.crm_mensagens_agendadas
    (audiencia_id, telefone, tipo, mensagem, agendada_para, status, origem, operador_id)
  SELECT NEW.id, NEW.telefone_notificacao, 'texto', msg, quando, 'pendente',
         'audiencia_lembrete_' || fase, auth.uid()
  FROM (VALUES
    ('d1',    v_d1,    '🔔 *Lembrete — audiência amanhã*' || E'\n' || rodape || E'\nData: ' || to_char(NEW.data_hora AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY às HH24:MI')),
    ('dia',   v_dia,   '📅 *Hoje tem audiência*' || E'\n' || rodape || E'\nÀs ' || to_char(NEW.data_hora AT TIME ZONE 'America/Sao_Paulo','HH24:MI')),
    ('min10', v_min10, '⏰ *Audiência em 10 minutos*' || E'\n' || rodape || E'\nÀs ' || to_char(NEW.data_hora AT TIME ZONE 'America/Sao_Paulo','HH24:MI'))
  ) AS f(fase, quando, msg)
  WHERE quando > now();   -- não agenda lembrete no passado

  RETURN NEW;
END;
$$;

-- O trigger em si já foi criado pelo arquivo anterior; recriado aqui para o
-- caso de este arquivo rodar sozinho.
DROP TRIGGER IF EXISTS trg_audiencias_agendar_lembretes ON public.audiencias;
CREATE TRIGGER trg_audiencias_agendar_lembretes
  AFTER INSERT OR UPDATE ON public.audiencias
  FOR EACH ROW EXECUTE FUNCTION public.audiencias_agendar_lembretes();

commit;

-- ── VERIFICAÇÃO ────────────────────────────────────────────────────────────
-- Simular a TELA (não service_role) e conferir que a gravação passa:
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<uuid do gestor>","role":"authenticated"}';
--     update public.audiencias set data_hora = data_hora + interval '1 minute'
--      where id = (select id from public.audiencias
--                   where status='agendada' and data_hora > now() limit 1);
--   rollback;
-- Sem o operador_id isso levanta "new row violates row-level security policy".
