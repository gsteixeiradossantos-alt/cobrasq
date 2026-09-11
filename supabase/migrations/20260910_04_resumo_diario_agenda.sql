-- ============================================================================
-- Resumo diário da agenda no WhatsApp do escritório, às 07:00 (BRT).
--
-- NÃO APLICADA EM PRODUÇÃO (aguardando autorização). Rollback pareado em
-- 20260910_04_resumo_diario_agenda_rollback.sql.
--
-- POR QUÊ. Decisão do gestor em 10/09/2026: "todo aviso no WhatsApp". Os
-- avisos individuais (audiência: 3 fases; lembrete/tarefa: 3; prazo: 2) já
-- existem, mas cada um chega solto. Falta a visão do dia inteiro numa mensagem
-- só, antes de o expediente começar — o que a Google Agenda dava de graça e o
-- painel não dá sem abrir. Uma mensagem, uma vez por dia, com tudo o que está
-- em `audiencias` e `lembretes` para hoje.
--
-- O QUE ESTE ARQUIVO FAZ
--   1. Função public.resumo_diario_agenda(p_dry_run, p_dia):
--      - lê audiencias (status 'agendada') e lembretes (status 'agendado') do
--        dia, em horário de Brasília;
--      - monta três blocos: 🔴 Audiências (hora, processo curto, 1º réu
--        + "e outros", comarca), ⚠️ Prazos (origem = 'prazo': processo curto e título, sem
--        hora — a hora do prazo é convenção) e 📌 Lembretes (hora e título);
--      - enfileira UMA mensagem em crm_mensagens_agendadas para o número do
--        escritório, origem 'resumo_diario', agendada_para = now(); o worker
--        de sempre (pg_cron 1 min → cron-mensagens-agendadas → Z-API) envia;
--      - idempotente: se já existe resumo do dia na fila, não repete
--        (lição da régua da Bia, que duplicou lembrete 3x sem claim);
--      - dia útil sem nada: manda "Nenhuma audiência, prazo ou lembrete para
--        hoje", para o gestor saber que o resumo está vivo; fim de semana
--        sem nada: silêncio;
--      - p_dry_run = true devolve a mensagem sem enfileirar; p_dia permite
--        montar o resumo de outro dia (teste). Nenhum dos dois é usado pelo cron.
--   2. REVOKE de PUBLIC/anon/authenticated: SECURITY DEFINER que escreve na
--      fila não pode ficar exposta como RPC (regra da casa: revoke exige tirar
--      PUBLIC, não só anon). O cron roda como postgres.
--   3. pg_cron 'resumo-diario-agenda' às 10:00 UTC = 07:00 BRT (sem horário de
--      verão desde 2019), todos os dias; a própria função decide se fala.
--
-- FONTE DOS DADOS. Só o banco. Prazos e tarefas que hoje vivem apenas na
-- Google Agenda não entram até serem gravados em `lembretes` — a agenda é
-- espelho, não fonte (decisão de 10/09/2026). Os "Debito DDA" da agenda são
-- de automação externa e ficaram fora de propósito.
--
-- VERIFICAÇÃO. Dry-run em produção dentro de begin/rollback: função criada na
-- transação, chamada com p_dry_run = true para hoje e para 11/09 (dia com
-- audiência e lembretes), mensagem conferida, nada persiste. Texto no PR.
--
-- ROLLBACK
--   select cron.unschedule('resumo-diario-agenda');
--   drop function if exists public.resumo_diario_agenda(boolean, date);
-- ============================================================================

begin;

CREATE OR REPLACE FUNCTION public.resumo_diario_agenda(
  p_dry_run boolean DEFAULT false,
  p_dia     date    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tel    constant text := '46999223332';   -- mesmo número de lembretes.telefone_notificacao e do vigia
  v_hoje   date;
  v_ini    timestamptz;
  v_fim    timestamptz;
  v_dow    text;
  v_aud    text := '';
  v_prz    text := '';
  v_tar    text := '';
  v_n_aud  int  := 0;
  v_n_prz  int  := 0;
  v_n_tar  int  := 0;
  v_total  int;
  v_msg    text;
  r        record;
BEGIN
  v_hoje := coalesce(p_dia, (now() AT TIME ZONE 'America/Sao_Paulo')::date);
  v_ini  := v_hoje       AT TIME ZONE 'America/Sao_Paulo';   -- 00:00 BRT
  v_fim  := (v_hoje + 1) AT TIME ZONE 'America/Sao_Paulo';   -- 00:00 BRT do dia seguinte
  v_dow  := (ARRAY['seg','ter','qua','qui','sex','sáb','dom'])[extract(isodow FROM v_hoje)::int];

  -- 🔴 Audiências do dia
  FOR r IN
    SELECT a.data_hora, a.numero_processo, a.comarca,
           -- primeiro réu + "e outros": o aviso individual da audiência traz a lista inteira
           (SELECT (array_agg(p->>'nome' ORDER BY ord))[1]
                   || CASE WHEN count(*) > 1 THEN ' e outros' ELSE '' END
              FROM jsonb_array_elements(coalesce(a.partes, '[]'::jsonb)) WITH ORDINALITY AS t(p, ord)
             WHERE replace(upper(p->>'papel'), 'É', 'E') = 'REU') AS reus
      FROM public.audiencias a
     WHERE a.status = 'agendada'
       AND a.data_hora >= v_ini AND a.data_hora < v_fim
     ORDER BY a.data_hora
  LOOP
    v_n_aud := v_n_aud + 1;
    v_aud := v_aud || E'\n• ' || to_char(r.data_hora AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI')
          || ' — ' || coalesce(left(r.numero_processo, 10), '—')
          || ' · '  || coalesce(r.reus, '—')
          || CASE WHEN coalesce(r.comarca, '') <> '' THEN ' (' || r.comarca || ')' ELSE '' END;
  END LOOP;

  -- ⚠️ Prazos e 📌 Lembretes do dia
  FOR r IN
    SELECT l.data_hora, l.titulo, l.numero_processo, l.origem
      FROM public.lembretes l
     WHERE l.status = 'agendado'
       AND l.data_hora >= v_ini AND l.data_hora < v_fim
     ORDER BY l.data_hora, l.titulo
  LOOP
    IF r.origem = 'prazo' THEN
      v_n_prz := v_n_prz + 1;
      v_prz := v_prz || E'\n• '
            || CASE WHEN coalesce(r.numero_processo, '') <> '' THEN left(r.numero_processo, 10) || ' — ' ELSE '' END
            || r.titulo;
    ELSE
      v_n_tar := v_n_tar + 1;
      v_tar := v_tar || E'\n• ' || to_char(r.data_hora AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI')
            || ' — ' || r.titulo
            || CASE WHEN coalesce(r.numero_processo, '') <> '' THEN ' (' || left(r.numero_processo, 10) || ')' ELSE '' END;
    END IF;
  END LOOP;

  v_total := v_n_aud + v_n_prz + v_n_tar;

  IF v_total = 0 THEN
    IF extract(isodow FROM v_hoje) > 5 THEN
      RETURN jsonb_build_object('dia', v_hoje, 'itens', 0, 'enviado', false,
                                'motivo', 'fim de semana sem itens');
    END IF;
    v_msg := '📋 *COBRASQ — ' || v_dow || ' ' || to_char(v_hoje, 'DD/MM') || '*' || E'\n'
          || 'Nenhuma audiência, prazo ou lembrete para hoje.';
  ELSE
    v_msg := '📋 *COBRASQ — ' || v_dow || ' ' || to_char(v_hoje, 'DD/MM') || '*'
          || CASE WHEN v_n_aud > 0 THEN E'\n\n🔴 *Audiências (' || v_n_aud || ')*' || v_aud ELSE '' END
          || CASE WHEN v_n_prz > 0 THEN E'\n\n⚠️ *Prazos (' || v_n_prz || ')*'      || v_prz ELSE '' END
          || CASE WHEN v_n_tar > 0 THEN E'\n\n📌 *Lembretes (' || v_n_tar || ')*'   || v_tar ELSE '' END;
  END IF;

  IF p_dry_run THEN
    RETURN jsonb_build_object('dia', v_hoje, 'itens', v_total, 'enviado', false,
                              'dry_run', true, 'mensagem', v_msg);
  END IF;

  -- Um resumo por dia, mesmo que o cron rode duas vezes.
  IF EXISTS (SELECT 1 FROM public.crm_mensagens_agendadas
              WHERE origem = 'resumo_diario'
                AND agendada_para >= v_ini AND agendada_para < v_fim) THEN
    RETURN jsonb_build_object('dia', v_hoje, 'itens', v_total, 'enviado', false,
                              'motivo', 'já enfileirado hoje');
  END IF;

  INSERT INTO public.crm_mensagens_agendadas (telefone, tipo, mensagem, agendada_para, status, origem)
  VALUES (v_tel, 'texto', v_msg, now(), 'pendente', 'resumo_diario');

  RETURN jsonb_build_object('dia', v_hoje, 'itens', v_total, 'enviado', true);
END;
$$;

REVOKE ALL ON FUNCTION public.resumo_diario_agenda(boolean, date) FROM PUBLIC, anon, authenticated;

-- 07:00 BRT = 10:00 UTC. Reagendar se já existir (idempotente).
DO $$
BEGIN
  PERFORM cron.unschedule('resumo-diario-agenda');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
SELECT cron.schedule('resumo-diario-agenda', '0 10 * * *', $$select public.resumo_diario_agenda()$$);

commit;
