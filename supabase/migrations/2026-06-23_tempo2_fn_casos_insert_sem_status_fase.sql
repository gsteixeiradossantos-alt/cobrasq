-- TEMPO-2 (Passo 3) — fn_casos_insert deixa de gravar status/fase em `devedores`.
-- A dívida é fonte única em `cobrancas` (o INSERT de cobrancas abaixo mantém
-- v_status/v_fase). Pré-requisito para dropar as colunas depreciadas de devedores.
-- Reversível: basta recriar a função com status/fase no INSERT de devedores.
-- Definição idêntica à de produção, exceto a remoção de status/fase do INSERT
-- em public.devedores.

CREATE OR REPLACE FUNCTION public.fn_casos_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cliente_id  UUID;
  v_cobranca_id UUID;
  v_devedor_id  UUID;
  v_status TEXT;
  v_fase TEXT;
  v_valor_orig NUMERIC;
  v_valor_atual NUMERIC;
  v_data_entrada DATE;
  evt JSONB;
BEGIN
  IF NEW.credor IS NOT NULL AND NEW.credor <> '' THEN
    SELECT id INTO v_cliente_id FROM public.clientes
    WHERE LOWER(TRIM(nome)) = LOWER(TRIM(NEW.credor))
       OR LOWER(TRIM(COALESCE(nome_fantasia, ''))) = LOWER(TRIM(NEW.credor))
    LIMIT 1;
    IF v_cliente_id IS NULL THEN
      INSERT INTO public.clientes (nome, metadata)
      VALUES (NEW.credor, jsonb_build_object('origem','crm_auto_create','criado_em',NOW()))
      RETURNING id INTO v_cliente_id;
    END IF;
  END IF;

  v_status := CASE
    WHEN NEW.passo_atual = 'Encaminhado ao judicial'  THEN 'Ação judicial'
    WHEN NEW.passo_atual ILIKE '%acordo aceito%'      THEN 'Acordo'
    WHEN NEW.passo_atual ILIKE '%negociação%'         THEN 'Em negociação'
    WHEN NEW.passo_atual ILIKE '%sem contato%'        THEN 'Em contato'
    WHEN NEW.passo_atual ILIKE '%aguardando%'         THEN 'Em contato'
    WHEN NEW.passo_atual ILIKE '%mensagem enviada%'   THEN 'Em contato'
    ELSE 'Cobrar'
  END;
  v_fase := CASE WHEN NEW.passo_atual = 'Encaminhado ao judicial' THEN 'judicial' ELSE 'extrajudicial' END;

  v_valor_orig := COALESCE(
    NULLIF(NEW.divida ->> 'valorOriginal', '')::numeric,
    NULLIF(NEW.divida ->> 'valor_original', '')::numeric,
    NULLIF(NEW.divida ->> 'totalAvista', '')::numeric
  );
  v_valor_atual := COALESCE(
    NULLIF(NEW.divida ->> 'totalAvista', '')::numeric,
    NULLIF(NEW.divida ->> 'valorAtual', '')::numeric,
    v_valor_orig
  );
  v_data_entrada := COALESCE(NULLIF(NEW.divida ->> 'vencimento', '')::date, CURRENT_DATE);

  -- TEMPO-2: status/fase NÃO vão mais para `devedores` (vivem só em `cobrancas`).
  INSERT INTO public.devedores (
    cliente_id, nome, telefone, doc, assigned_to,
    endereco_crm, metadata, arquivado, created_at, updated_at
  ) VALUES (
    v_cliente_id, NEW.devedor, NEW.telefone, NEW.documento, NEW.assigned_to,
    NEW.endereco_crm,
    jsonb_build_object('origem','crm_via_view','credorOriginal', NEW.credor),
    false, NOW(), NOW()
  ) RETURNING id INTO v_devedor_id;

  v_cobranca_id := COALESCE(NEW.id, v_devedor_id);

  INSERT INTO public.cobrancas (
    id, cliente_id, status, fase, passo_atual, assigned_to, aguardando_resposta,
    encerramento, acordo_final, divida, valor_orig, valor_atual, data_entrada,
    metadata, objecao_adicionais, mesa_gestor, checklist_judicial,
    arquivado, created_at, updated_at, etapa_atualizada_em
  ) VALUES (
    v_cobranca_id, v_cliente_id, v_status, v_fase, NEW.passo_atual, NEW.assigned_to,
    COALESCE(NEW.aguardando_resposta, false),
    NEW.encerramento, NEW.acordo_final, COALESCE(NEW.divida, '{}'::jsonb),
    v_valor_orig, v_valor_atual, v_data_entrada,
    jsonb_build_object('credorOriginal', NEW.credor, 'origem','crm_via_view',
      'crm_created_by', NEW.created_by, 'crm_assigned_to', NEW.assigned_to),
    NEW.objecao_adicionais, NEW.mesa_gestor, NEW.checklist_judicial,
    false, COALESCE(NEW.created_at, NOW()), COALESCE(NEW.updated_at, NOW()), COALESCE(NEW.etapa_atualizada_em, NOW())
  );

  INSERT INTO public.cobranca_partes (cobranca_id, devedor_id, papel, principal)
  VALUES (v_cobranca_id, v_devedor_id, 'emitente', true);

  IF NEW.historico IS NOT NULL AND jsonb_typeof(NEW.historico) = 'array' THEN
    FOR evt IN SELECT * FROM jsonb_array_elements(NEW.historico)
    LOOP
      INSERT INTO public.devedor_eventos (devedor_id, cobranca_id, tipo, payload, criado_em)
      VALUES (v_devedor_id, v_cobranca_id, 'historico_legacy', evt,
        COALESCE(NULLIF(evt->>'quando','')::TIMESTAMPTZ, NOW()));
    END LOOP;
  END IF;

  NEW.id := v_cobranca_id;
  RETURN NEW;
END;
$function$;
