-- Etapa 1: estender view `casos` com 4 colunas faltantes
-- (objecao_adicionais, mesa_gestor, endereco_crm, checklist_judicial)
-- + marcar security_invoker=true (resolve advisor 0010_security_definer_view)
-- + ajustar fn_casos_update pra escrever essas colunas
-- + REVOKE EXECUTE de anon nas fn_casos_* e current_user_papel (advisors 0028/0029)
-- Aplicada em produção via MCP em 2026-05-11.

CREATE OR REPLACE VIEW public.casos
WITH (security_invoker=true) AS
SELECT
  d.id,
  d.assigned_to AS created_by,
  d.assigned_to,
  d.nome AS devedor,
  d.telefone,
  d.doc AS documento,
  d.cliente_id,
  COALESCE(c.nome_fantasia, c.nome, (d.metadata ->> 'credorOriginal'::text)) AS credor,
  c.doc AS credor_doc,
  c.nome AS credor_razao_social,
  TRIM(BOTH ', '::text FROM ((((((COALESCE(d.rua, ''::text) ||
      CASE WHEN ((d.numero IS NOT NULL) AND (d.numero <> ''::text)) THEN (', n. '::text || d.numero) ELSE ''::text END) ||
      CASE WHEN ((d.complemento IS NOT NULL) AND (d.complemento <> ''::text)) THEN (', '::text || d.complemento) ELSE ''::text END) ||
      CASE WHEN ((d.bairro IS NOT NULL) AND (d.bairro <> ''::text)) THEN (', '::text || d.bairro) ELSE ''::text END) ||
      CASE WHEN ((d.cidade IS NOT NULL) AND (d.cidade <> ''::text)) THEN (', '::text || d.cidade) ELSE ''::text END) ||
      CASE WHEN ((d.uf IS NOT NULL) AND (d.uf <> ''::text)) THEN (' — '::text || d.uf) ELSE ''::text END) ||
      CASE WHEN ((d.cep IS NOT NULL) AND (d.cep <> ''::text)) THEN (', CEP '::text || d.cep) ELSE ''::text END)) AS endereco,
  TRIM(BOTH ', '::text FROM ((((((COALESCE(c.rua, ''::text) ||
      CASE WHEN ((c.numero IS NOT NULL) AND (c.numero <> ''::text)) THEN (', n. '::text || c.numero) ELSE ''::text END) ||
      CASE WHEN ((c.complemento IS NOT NULL) AND (c.complemento <> ''::text)) THEN (', '::text || c.complemento) ELSE ''::text END) ||
      CASE WHEN ((c.bairro IS NOT NULL) AND (c.bairro <> ''::text)) THEN (', '::text || c.bairro) ELSE ''::text END) ||
      CASE WHEN ((c.cidade IS NOT NULL) AND (c.cidade <> ''::text)) THEN (', '::text || c.cidade) ELSE ''::text END) ||
      CASE WHEN ((c.uf IS NOT NULL) AND (c.uf <> ''::text)) THEN (' — '::text || c.uf) ELSE ''::text END) ||
      CASE WHEN ((c.cep IS NOT NULL) AND (c.cep <> ''::text)) THEN (', CEP '::text || c.cep) ELSE ''::text END)) AS credor_endereco,
  (d.valor_orig)::numeric AS valor_orig,
  (d.valor_atual)::numeric AS valor_atual,
  COALESCE(((d.divida ->> 'vencimento'::text))::date, ((d.metadata ->> 'vencimento'::text))::date, d.data_entrada) AS divida_vencimento,
  COALESCE((d.metadata ->> 'titulo'::text), (d.divida ->> 'descricao'::text), (d.divida ->> 'titulo'::text)) AS divida_descricao,
  COALESCE(d.divida, '{}'::jsonb) AS divida,
  COALESCE(d.passo_atual,
    CASE WHEN (d.status = 'Cobrar'::text) THEN 'Aguardando 1ª abordagem'::text ELSE NULL::text END) AS passo_atual,
  COALESCE(d.aguardando_resposta, false) AS aguardando_resposta,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'quando', devedor_eventos.criado_em,
      'acao', COALESCE(
        (devedor_eventos.payload ->> 'acao_completa'::text),
        (devedor_eventos.payload ->> 'acao'::text),
        (devedor_eventos.payload ->> 'texto'::text),
        (devedor_eventos.payload ->> 'descricao'::text),
        (devedor_eventos.payload ->> 'mensagem'::text),
        devedor_eventos.tipo
      )) ORDER BY devedor_eventos.criado_em
    ) AS jsonb_agg
    FROM devedor_eventos
    WHERE (devedor_eventos.devedor_id = d.id)
  ), '[]'::jsonb) AS historico,
  (d.encerramento IS NOT NULL) AS encerrado,
  d.encerramento,
  d.acordo_final,
  d.etapa_atualizada_em,
  d.created_at,
  d.updated_at,
  d.objecao_adicionais,
  d.mesa_gestor,
  d.endereco_crm,
  d.checklist_judicial
FROM devedores d
LEFT JOIN clientes c ON c.id = d.cliente_id
WHERE NOT COALESCE(d.arquivado, false)
  AND (
    d.passo_atual IS NOT NULL
    OR d.encerramento IS NOT NULL
    OR (d.metadata ->> 'origem'::text) = 'migracao_crm_2026-05-08'::text
    OR d.status = ANY (ARRAY['Cobrar'::text, 'Em contato'::text, 'Em negociação'::text, 'Acordo'::text, 'Ação judicial'::text])
  );

COMMENT ON VIEW public.casos IS 'View de leitura+escrita pra CRM. INSERT/UPDATE/DELETE redirecionados via triggers fn_casos_*. SECURITY INVOKER (RLS de devedores/clientes aplicada).';

CREATE OR REPLACE FUNCTION public.fn_casos_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status TEXT;
  v_cliente_id UUID;
  evt JSONB;
BEGIN
  IF NEW.credor IS DISTINCT FROM OLD.credor AND NEW.credor IS NOT NULL AND NEW.credor <> '' THEN
    SELECT id INTO v_cliente_id
    FROM public.clientes
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

  UPDATE public.devedores SET
    nome                = COALESCE(NEW.devedor, nome),
    telefone            = NEW.telefone,
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
    endereco_crm        = NEW.endereco_crm,
    checklist_judicial  = NEW.checklist_judicial
  WHERE id = NEW.id;

  IF NEW.historico IS NOT NULL
     AND jsonb_typeof(NEW.historico) = 'array'
     AND NEW.historico IS DISTINCT FROM OLD.historico THEN
    FOR evt IN SELECT * FROM jsonb_array_elements(NEW.historico)
    LOOP
      IF OLD.historico IS NULL OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(OLD.historico) AS old_evt
        WHERE old_evt = evt
      ) THEN
        INSERT INTO public.devedor_eventos (devedor_id, tipo, payload, criado_em, autor_id)
        VALUES (
          NEW.id,
          'historico_legacy',
          evt,
          COALESCE(NULLIF(evt->>'quando','')::TIMESTAMPTZ, NOW()),
          auth.uid()
        );
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_casos_insert() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_casos_update() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_casos_delete() FROM anon;
REVOKE EXECUTE ON FUNCTION public.current_user_papel() FROM anon;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_profiles_update' AND pronamespace = 'public'::regnamespace) THEN
    REVOKE EXECUTE ON FUNCTION public.fn_profiles_update() FROM anon;
  END IF;
END $$;
