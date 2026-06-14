-- HOTFIX (aplicado em produção via MCP em 2026-06-11, ~16h40 UTC):
-- A view casos quebrava com erro 22007 (invalid input syntax for type date: "")
-- quando um devedor sincronizado do faturamento trazia divida.vencimento ou
-- metadata.vencimento como string vazia. Resultado: GET /rest/v1/casos -> 400
-- para TODOS os usuários (CRM em branco + toast de erro).
-- Correção: helpers safe_date/safe_numeric (valor inválido -> NULL) e view
-- recriada usando-os nos casts de valor_orig, valor_atual e divida_vencimento.
-- A definição completa aplicada está na migração via MCP
-- 'fix_view_casos_casts_seguros' (mesmo conteúdo deste arquivo).

create or replace function public.safe_date(t text)
returns date language sql immutable as $$
  select case when t ~ '^\d{4}-\d{2}-\d{2}' then substring(t from 1 for 10)::date end
$$;

create or replace function public.safe_numeric(t text)
returns numeric language sql immutable as $$
  select case when t ~ '^-?\d+(\.\d+)?$' then t::numeric end
$$;

create or replace view public.casos with (security_invoker = true) as
 SELECT d.id,
    d.assigned_to AS created_by,
    d.assigned_to,
    d.nome AS devedor,
    d.telefone,
    d.doc AS documento,
    d.cliente_id,
    COALESCE(c.nome_fantasia, c.nome, d.metadata ->> 'credorOriginal') AS credor,
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
    COALESCE(d.valor_orig::numeric,
             public.safe_numeric(d.divida ->> 'valorOriginal'),
             public.safe_numeric(d.divida ->> 'valor_original'),
             public.safe_numeric(d.divida ->> 'totalAvista')) AS valor_orig,
    COALESCE(d.valor_atual::numeric,
             public.safe_numeric(d.divida ->> 'totalAvista'),
             public.safe_numeric(d.divida ->> 'valorAtual')) AS valor_atual,
    COALESCE(public.safe_date(d.divida ->> 'vencimento'),
             public.safe_date(d.metadata ->> 'vencimento'),
             d.data_entrada) AS divida_vencimento,
    COALESCE(d.metadata ->> 'titulo', d.divida ->> 'descricao', d.divida ->> 'titulo') AS divida_descricao,
    COALESCE(d.divida, '{}'::jsonb) AS divida,
    COALESCE(d.passo_atual,
        CASE WHEN d.status = ANY (ARRAY['Cobrar','Fazer ação','Notificação enviada','Petição inicial'])
             THEN 'Aguardando 1ª abordagem' ELSE NULL END) AS passo_atual,
    COALESCE(d.aguardando_resposta, false) AS aguardando_resposta,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object('quando', devedor_eventos.criado_em,
                 'acao', COALESCE(devedor_eventos.payload ->> 'acao_completa',
                                  devedor_eventos.payload ->> 'acao',
                                  devedor_eventos.payload ->> 'texto',
                                  devedor_eventos.payload ->> 'descricao',
                                  devedor_eventos.payload ->> 'mensagem',
                                  devedor_eventos.tipo)) ORDER BY devedor_eventos.criado_em)
           FROM devedor_eventos
          WHERE devedor_eventos.devedor_id = d.id), '[]'::jsonb) AS historico,
    d.encerramento IS NOT NULL AS encerrado,
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
    AND (d.passo_atual IS NOT NULL OR d.encerramento IS NOT NULL
         OR (d.metadata ->> 'origem') = 'migracao_crm_2026-05-08'
         OR (d.status = ANY (ARRAY['Cobrar','Fazer ação','Em contato','Em negociação','Acordo','Ação judicial','Recebido','Quitado','Notificação enviada','Proposta enviada','Acordo firmado','Em pagamento','Devolvida','Sem êxito','Petição inicial','Citação','Contestação','Audiência','Sentença','Recurso','Execução','Penhora','Hasta pública','Encerrado'])));
