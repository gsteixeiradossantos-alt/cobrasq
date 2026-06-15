-- ============================================================================
-- Reestruturação Contatos + Cobranças (modelo Ástrea) — FASE B
-- A view `casos` (usada por CRM + Faturamento) passa a ler de `cobrancas`,
-- expondo as MESMAS colunas de antes (compat) + nova coluna `partes` (todos os
-- responsáveis com papel). Triggers INSTEAD OF reescritos para gravar em
-- cobrancas + cobranca_partes + devedores(contato principal).
-- ----------------------------------------------------------------------------
-- GUARDA F-04: re-declara WITH (security_invoker = true) (ver migrations/README).
-- Mantém a MESMA ordem/tipos de colunas da definição vigente (2026-06-11b) e só
-- ACRESCENTA `partes` ao final → compatível com CREATE OR REPLACE VIEW (preserva
-- grants e os triggers INSTEAD OF já existentes).
-- ----------------------------------------------------------------------------
-- Pré-requisito: 2026-06-15a_cobrancas_e_partes.sql aplicado.
-- Depende dos helpers public.safe_date / public.safe_numeric (2026-06-11b).
-- NÃO aplicado automaticamente. Rollback: 2026-06-15b_..._rollback.sql
-- ============================================================================

CREATE OR REPLACE VIEW public.casos WITH (security_invoker = true) AS
 SELECT co.id,
    co.assigned_to AS created_by,
    co.assigned_to,
    d.nome AS devedor,
    d.telefone,
    d.doc AS documento,
    co.cliente_id,
    COALESCE(c.nome_fantasia, c.nome, co.metadata ->> 'credorOriginal') AS credor,
    c.nome AS credor_razao_social,
    c.doc AS credor_doc,
    TRIM(BOTH ', ' FROM (((((COALESCE(c.rua, '') ||
        CASE WHEN c.numero IS NOT NULL AND c.numero <> '' THEN ', n. ' || c.numero ELSE '' END) ||
        CASE WHEN c.complemento IS NOT NULL AND c.complemento <> '' THEN ', ' || c.complemento ELSE '' END) ||
        CASE WHEN c.bairro IS NOT NULL AND c.bairro <> '' THEN ', ' || c.bairro ELSE '' END) ||
        CASE WHEN c.cidade IS NOT NULL AND c.cidade <> '' THEN ', ' || c.cidade ELSE '' END) ||
        CASE WHEN c.uf IS NOT NULL AND c.uf <> '' THEN ' — ' || c.uf ELSE '' END) ||
        CASE WHEN c.cep IS NOT NULL AND c.cep <> '' THEN ', CEP ' || c.cep ELSE '' END) AS credor_endereco,
    c.cidade AS credor_cidade,
    TRIM(BOTH ', ' FROM (((((COALESCE(d.rua, '') ||
        CASE WHEN d.numero IS NOT NULL AND d.numero <> '' THEN ', n. ' || d.numero ELSE '' END) ||
        CASE WHEN d.complemento IS NOT NULL AND d.complemento <> '' THEN ', ' || d.complemento ELSE '' END) ||
        CASE WHEN d.bairro IS NOT NULL AND d.bairro <> '' THEN ', ' || d.bairro ELSE '' END) ||
        CASE WHEN d.cidade IS NOT NULL AND d.cidade <> '' THEN ', ' || d.cidade ELSE '' END) ||
        CASE WHEN d.uf IS NOT NULL AND d.uf <> '' THEN ' — ' || d.uf ELSE '' END) ||
        CASE WHEN d.cep IS NOT NULL AND d.cep <> '' THEN ', CEP ' || d.cep ELSE '' END) AS endereco,
    COALESCE(co.valor_orig::numeric,
             public.safe_numeric(co.divida ->> 'valorOriginal'),
             public.safe_numeric(co.divida ->> 'valor_original'),
             public.safe_numeric(co.divida ->> 'totalAvista')) AS valor_orig,
    COALESCE(co.valor_atual::numeric,
             public.safe_numeric(co.divida ->> 'totalAvista'),
             public.safe_numeric(co.divida ->> 'valorAtual')) AS valor_atual,
    COALESCE(public.safe_date(co.divida ->> 'vencimento'),
             public.safe_date(co.metadata ->> 'vencimento'),
             co.data_entrada) AS divida_vencimento,
    COALESCE(co.metadata ->> 'titulo', co.divida ->> 'descricao', co.divida ->> 'titulo') AS divida_descricao,
    COALESCE(co.divida, '{}'::jsonb) AS divida,
    COALESCE(co.passo_atual,
        CASE WHEN co.status = ANY (ARRAY['Cobrar','Fazer ação','Notificação enviada','Petição inicial'])
             THEN 'Aguardando 1ª abordagem' ELSE NULL END) AS passo_atual,
    COALESCE(co.aguardando_resposta, false) AS aguardando_resposta,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object('quando', devedor_eventos.criado_em,
                 'acao', COALESCE(devedor_eventos.payload ->> 'acao_completa',
                                  devedor_eventos.payload ->> 'acao',
                                  devedor_eventos.payload ->> 'texto',
                                  devedor_eventos.payload ->> 'descricao',
                                  devedor_eventos.payload ->> 'mensagem',
                                  devedor_eventos.tipo)) ORDER BY devedor_eventos.criado_em)
           FROM devedor_eventos
          WHERE devedor_eventos.cobranca_id = co.id), '[]'::jsonb) AS historico,
    co.encerramento IS NOT NULL AS encerrado,
    co.encerramento,
    co.acordo_final,
    co.etapa_atualizada_em,
    co.created_at,
    co.updated_at,
    co.objecao_adicionais,
    co.mesa_gestor,
    d.endereco_crm,
    co.checklist_judicial,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object(
                 'devedor_id', p.devedor_id,
                 'papel', p.papel,
                 'principal', p.principal,
                 'nome', pd.nome,
                 'doc', pd.doc,
                 'telefone', pd.telefone)
                 ORDER BY p.principal DESC, p.created_at)
           FROM cobranca_partes p
           JOIN devedores pd ON pd.id = p.devedor_id
          WHERE p.cobranca_id = co.id), '[]'::jsonb) AS partes
   FROM cobrancas co
     LEFT JOIN cobranca_partes pp ON pp.cobranca_id = co.id AND pp.principal
     LEFT JOIN devedores d ON d.id = pp.devedor_id
     LEFT JOIN clientes c ON c.id = co.cliente_id
  WHERE NOT COALESCE(co.arquivado, false)
    AND (co.passo_atual IS NOT NULL OR co.encerramento IS NOT NULL
         OR (co.metadata ->> 'origem') = 'migracao_crm_2026-05-08'
         OR (co.status = ANY (ARRAY['Cobrar','Fazer ação','Em contato','Em negociação','Acordo','Ação judicial','Recebido','Quitado','Notificação enviada','Proposta enviada','Acordo firmado','Em pagamento','Devolvida','Sem êxito','Petição inicial','Citação','Contestação','Audiência','Sentença','Recurso','Execução','Penhora','Hasta pública','Encerrado'])));

COMMENT ON VIEW public.casos IS 'View leitura+escrita do CRM/Faturamento sobre cobrancas. INSTEAD OF triggers fn_casos_*. SECURITY INVOKER. Coluna partes = responsáveis com papel.';

-- ════════════════════════════════════════════════════════════════════════════
-- TRIGGER FUNCTIONS reescritos (gravam em cobrancas + cobranca_partes + contato)
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_casos_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cliente_id  UUID;
  v_cobranca_id UUID := COALESCE(NEW.id, gen_random_uuid());
  v_devedor_id  UUID;
  v_status TEXT;
  v_fase TEXT;
  v_valor_orig NUMERIC;
  v_valor_atual NUMERIC;
  v_data_entrada DATE;
  evt JSONB;
BEGIN
  -- credor -> cliente (acha por nome/fantasia ou cria)
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

  -- 1) CONTATO principal (pessoa) em devedores
  INSERT INTO public.devedores (
    cliente_id, nome, telefone, doc, status, fase, assigned_to,
    endereco_crm, metadata, arquivado, created_at, updated_at
  ) VALUES (
    v_cliente_id, NEW.devedor, NEW.telefone, NEW.documento, v_status, v_fase, NEW.assigned_to,
    NEW.endereco_crm,
    jsonb_build_object('origem','crm_via_view','credorOriginal', NEW.credor),
    false, NOW(), NOW()
  ) RETURNING id INTO v_devedor_id;

  -- 2) COBRANÇA (débito)
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

  -- 3) parte principal (papel emitente)
  INSERT INTO public.cobranca_partes (cobranca_id, devedor_id, papel, principal)
  VALUES (v_cobranca_id, v_devedor_id, 'emitente', true);

  -- 4) histórico legado -> eventos (chaveado por cobranca_id)
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

CREATE OR REPLACE FUNCTION public.fn_casos_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status TEXT;
  v_cliente_id UUID;
  v_devedor_id UUID;
  evt JSONB;
BEGIN
  IF NEW.credor IS DISTINCT FROM OLD.credor AND NEW.credor IS NOT NULL AND NEW.credor <> '' THEN
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
    WHEN NEW.encerramento IS NOT NULL AND NEW.encerramento->>'tipo' = 'acordo'    THEN 'Acordo'
    WHEN NEW.encerramento IS NOT NULL AND NEW.encerramento->>'tipo' = 'judicial'  THEN 'Ação judicial'
    WHEN NEW.encerramento IS NOT NULL AND NEW.encerramento->>'tipo' = 'sem_exito' THEN 'Sem êxito'
    WHEN NEW.passo_atual = 'Encaminhado ao judicial' THEN 'Ação judicial'
    WHEN NEW.passo_atual ILIKE '%acordo aceito%'     THEN 'Acordo'
    WHEN NEW.passo_atual ILIKE '%negociação%'        THEN 'Em negociação'
    WHEN NEW.passo_atual ILIKE '%sem contato%'       THEN 'Em contato'
    WHEN NEW.passo_atual ILIKE '%aguardando%'        THEN 'Em contato'
    WHEN NEW.passo_atual ILIKE '%mensagem enviada%'  THEN 'Em contato'
    ELSE 'Cobrar'
  END;

  -- atualiza a COBRANÇA
  UPDATE public.cobrancas SET
    cliente_id          = COALESCE(v_cliente_id, cliente_id),
    passo_atual         = NEW.passo_atual,
    aguardando_resposta = COALESCE(NEW.aguardando_resposta, false),
    encerramento        = NEW.encerramento,
    acordo_final        = NEW.acordo_final,
    assigned_to         = NEW.assigned_to,
    divida              = COALESCE(NEW.divida, divida),
    status              = v_status,
    fase                = CASE WHEN NEW.passo_atual = 'Encaminhado ao judicial' THEN 'judicial' ELSE fase END,
    metadata            = CASE
                            WHEN NEW.credor IS NOT NULL AND NEW.credor IS DISTINCT FROM OLD.credor
                            THEN COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('credorOriginal', NEW.credor)
                            ELSE metadata
                          END,
    updated_at          = NOW(),
    etapa_atualizada_em = COALESCE(NEW.etapa_atualizada_em, etapa_atualizada_em),
    objecao_adicionais  = NEW.objecao_adicionais,
    mesa_gestor         = NEW.mesa_gestor,
    checklist_judicial  = NEW.checklist_judicial
  WHERE id = NEW.id;

  -- atualiza o CONTATO principal (pessoa)
  SELECT devedor_id INTO v_devedor_id
  FROM public.cobranca_partes WHERE cobranca_id = NEW.id AND principal LIMIT 1;

  IF v_devedor_id IS NOT NULL THEN
    UPDATE public.devedores SET
      nome         = COALESCE(NEW.devedor, nome),
      telefone     = NEW.telefone,
      doc          = COALESCE(NEW.documento, doc),
      cliente_id   = COALESCE(v_cliente_id, cliente_id),
      endereco_crm = NEW.endereco_crm,
      updated_at   = NOW()
    WHERE id = v_devedor_id;
  END IF;

  -- histórico incremental -> eventos (cobranca_id)
  IF NEW.historico IS NOT NULL
     AND jsonb_typeof(NEW.historico) = 'array'
     AND NEW.historico IS DISTINCT FROM OLD.historico THEN
    FOR evt IN SELECT * FROM jsonb_array_elements(NEW.historico)
    LOOP
      IF OLD.historico IS NULL OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(OLD.historico) AS old_evt WHERE old_evt = evt
      ) THEN
        INSERT INTO public.devedor_eventos (devedor_id, cobranca_id, tipo, payload, criado_em, autor_id)
        VALUES (v_devedor_id, NEW.id, 'historico_legacy', evt,
          COALESCE(NULLIF(evt->>'quando','')::TIMESTAMPTZ, NOW()), auth.uid());
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_casos_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Remove a cobrança (cascade: cobranca_partes + filhos por cobranca_id).
  -- O CONTATO (devedores) é preservado — vira só cadastro de pessoa.
  DELETE FROM public.cobrancas WHERE id = OLD.id;
  RETURN OLD;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_casos_insert() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_casos_update() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_casos_delete() FROM PUBLIC, anon, authenticated;
