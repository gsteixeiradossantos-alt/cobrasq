-- ============================================================================
-- Resumo das 07h: número do processo INTEIRO em todas as linhas.
--
-- APLICADA EM PRODUÇÃO em 11/09/2026 (MCP apply_migration, nome `resumo_cnj_inteiro`),
-- com autorização do gestor. Rollback: reaplicar a função de 20260910_04.
--
-- POR QUÊ. A 20260910_04 encurtava o CNJ para os 10 primeiros dígitos
-- (`0005728-38`) para a mensagem ficar menor. O Gustavo pesquisa — na agenda e no
-- WhatsApp — pelo número inteiro (`0005728-38.2026.8.16.0083`); o encurtado não
-- acha nada. Mesma decisão de 11/09 para o título dos eventos da agenda. Os avisos
-- individuais já traziam o número inteiro; só o resumo destoava.
--
-- O QUE MUDA. Três `left(r.numero_processo, 10)` viram `r.numero_processo`
-- (audiências, prazos e lembretes). Nada mais.
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
          || ' — ' || coalesce(r.numero_processo, '—')
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
            || CASE WHEN coalesce(r.numero_processo, '') <> '' THEN r.numero_processo || ' — ' ELSE '' END
            || r.titulo;
    ELSE
      v_n_tar := v_n_tar + 1;
      v_tar := v_tar || E'\n• ' || to_char(r.data_hora AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI')
            || ' — ' || r.titulo
            || CASE WHEN coalesce(r.numero_processo, '') <> '' THEN ' (' || r.numero_processo || ')' ELSE '' END;
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

commit;
