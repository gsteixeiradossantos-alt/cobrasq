-- Etapa 9: defaults + auto-fill (Parte 2 do plano)
-- Aplicada em produção via MCP em 2026-05-11.
--
-- 1) View `casos` REFEITA (DROP CASCADE + CREATE) — perdeu colunas em update
--    intermediário; agora tem objecao_adicionais, mesa_gestor, endereco_crm,
--    checklist_judicial DE VOLTA + nova credor_cidade + COALESCE em
--    valor_orig/valor_atual (extrai de divida JSONB se devedores.valor_orig é null).
-- 2) Triggers casos_trg_insert/update/delete RECRIADOS (DROP CASCADE removeu).
-- 3) fn_casos_insert agora popula devedores.valor_orig + valor_atual +
--    data_entrada a partir do divida JSONB.
-- 4) Templates ativos: default vara_distribuicao = 'Juizado Especial Cível'.
-- 5) Backfill valor_orig/valor_atual em 14/15 devedores existentes.

DROP VIEW IF EXISTS public.casos CASCADE;

CREATE VIEW public.casos
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
  c.nome AS credor_razao_social,
  c.doc AS credor_doc,
  TRIM(BOTH ', '::text FROM ((((((COALESCE(c.rua, ''::text) ||
      CASE WHEN ((c.numero IS NOT NULL) AND (c.numero <> ''::text)) THEN (', n. '::text || c.numero) ELSE ''::text END) ||
      CASE WHEN ((c.complemento IS NOT NULL) AND (c.complemento <> ''::text)) THEN (', '::text || c.complemento) ELSE ''::text END) ||
      CASE WHEN ((c.bairro IS NOT NULL) AND (c.bairro <> ''::text)) THEN (', '::text || c.bairro) ELSE ''::text END) ||
      CASE WHEN ((c.cidade IS NOT NULL) AND (c.cidade <> ''::text)) THEN (', '::text || c.cidade) ELSE ''::text END) ||
      CASE WHEN ((c.uf IS NOT NULL) AND (c.uf <> ''::text)) THEN (' — '::text || c.uf) ELSE ''::text END) ||
      CASE WHEN ((c.cep IS NOT NULL) AND (c.cep <> ''::text)) THEN (', CEP '::text || c.cep) ELSE ''::text END)) AS credor_endereco,
  c.cidade AS credor_cidade,
  TRIM(BOTH ', '::text FROM ((((((COALESCE(d.rua, ''::text) ||
      CASE WHEN ((d.numero IS NOT NULL) AND (d.numero <> ''::text)) THEN (', n. '::text || d.numero) ELSE ''::text END) ||
      CASE WHEN ((d.complemento IS NOT NULL) AND (d.complemento <> ''::text)) THEN (', '::text || d.complemento) ELSE ''::text END) ||
      CASE WHEN ((d.bairro IS NOT NULL) AND (d.bairro <> ''::text)) THEN (', '::text || d.bairro) ELSE ''::text END) ||
      CASE WHEN ((d.cidade IS NOT NULL) AND (d.cidade <> ''::text)) THEN (', '::text || d.cidade) ELSE ''::text END) ||
      CASE WHEN ((d.uf IS NOT NULL) AND (d.uf <> ''::text)) THEN (' — '::text || d.uf) ELSE ''::text END) ||
      CASE WHEN ((d.cep IS NOT NULL) AND (d.cep <> ''::text)) THEN (', CEP '::text || d.cep) ELSE ''::text END)) AS endereco,
  COALESCE(
    (d.valor_orig)::numeric,
    NULLIF(d.divida ->> 'valorOriginal', '')::numeric,
    NULLIF(d.divida ->> 'valor_original', '')::numeric,
    NULLIF(d.divida ->> 'totalAvista', '')::numeric
  ) AS valor_orig,
  COALESCE(
    (d.valor_atual)::numeric,
    NULLIF(d.divida ->> 'totalAvista', '')::numeric,
    NULLIF(d.divida ->> 'valorAtual', '')::numeric
  ) AS valor_atual,
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

COMMENT ON VIEW public.casos IS 'View de leitura+escrita pra CRM. INSTEAD OF triggers fn_casos_*. SECURITY INVOKER.';

CREATE TRIGGER casos_trg_insert INSTEAD OF INSERT ON public.casos
  FOR EACH ROW EXECUTE FUNCTION public.fn_casos_insert();
CREATE TRIGGER casos_trg_update INSTEAD OF UPDATE ON public.casos
  FOR EACH ROW EXECUTE FUNCTION public.fn_casos_update();
CREATE TRIGGER casos_trg_delete INSTEAD OF DELETE ON public.casos
  FOR EACH ROW EXECUTE FUNCTION public.fn_casos_delete();

CREATE OR REPLACE FUNCTION public.fn_casos_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cliente_id UUID;
  v_devedor_id UUID := COALESCE(NEW.id, gen_random_uuid());
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

  INSERT INTO public.devedores (
    id, cliente_id, nome, telefone, status, fase,
    passo_atual, assigned_to, aguardando_resposta,
    encerramento, acordo_final, divida,
    valor_orig, valor_atual, data_entrada,
    metadata, arquivado, created_at, updated_at, etapa_atualizada_em
  ) VALUES (
    v_devedor_id, v_cliente_id, NEW.devedor, NEW.telefone, v_status, v_fase,
    NEW.passo_atual, NEW.assigned_to, COALESCE(NEW.aguardando_resposta, false),
    NEW.encerramento, NEW.acordo_final, COALESCE(NEW.divida, '{}'::jsonb),
    v_valor_orig, v_valor_atual, v_data_entrada,
    jsonb_build_object('credorOriginal', NEW.credor, 'origem', 'crm_via_view',
      'crm_created_by', NEW.created_by, 'crm_assigned_to', NEW.assigned_to),
    false, COALESCE(NEW.created_at, NOW()), COALESCE(NEW.updated_at, NOW()), COALESCE(NEW.etapa_atualizada_em, NOW())
  );

  IF NEW.historico IS NOT NULL AND jsonb_typeof(NEW.historico) = 'array' THEN
    FOR evt IN SELECT * FROM jsonb_array_elements(NEW.historico)
    LOOP
      INSERT INTO public.devedor_eventos (devedor_id, tipo, payload, criado_em)
      VALUES (v_devedor_id, 'historico_legacy', evt,
        COALESCE(NULLIF(evt->>'quando','')::TIMESTAMPTZ, NOW()));
    END LOOP;
  END IF;

  NEW.id := v_devedor_id;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_casos_insert() FROM PUBLIC, anon, authenticated;

UPDATE public.peticao_templates
SET variaveis = (
  SELECT jsonb_agg(
    CASE WHEN elem->>'key' = 'processo.vara_distribuicao' AND elem->>'default' = 'Vara Cível'
      THEN jsonb_set(elem, '{default}', '"Juizado Especial Cível"'::jsonb)
      ELSE elem END
  )
  FROM jsonb_array_elements(variaveis) elem
)
WHERE ativo = true
  AND variaveis @> '[{"key": "processo.vara_distribuicao"}]'::jsonb;

UPDATE public.devedores
SET
  valor_orig = COALESCE(valor_orig,
    NULLIF(divida ->> 'valorOriginal', '')::numeric,
    NULLIF(divida ->> 'valor_original', '')::numeric,
    NULLIF(divida ->> 'totalAvista', '')::numeric),
  valor_atual = COALESCE(valor_atual,
    NULLIF(divida ->> 'totalAvista', '')::numeric,
    NULLIF(divida ->> 'valorAtual', '')::numeric)
WHERE (valor_orig IS NULL OR valor_atual IS NULL)
  AND divida IS NOT NULL AND divida <> '{}'::jsonb;
