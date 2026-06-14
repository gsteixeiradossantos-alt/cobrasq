-- Fix bug: devedor com status='Fazer ação' (criado no Faturamento) não aparecia
-- no CRM. A view casos só aceitava status IN ('Cobrar','Em contato','Em negociação',
-- 'Acordo','Ação judicial'). Aplicada em produção via MCP em 2026-05-12.
--
-- 1) Adiciona 'Fazer ação' à lista de status aceitos no WHERE.
-- 2) Quando passo_atual é null e status é 'Cobrar' OU 'Fazer ação', mostra
--    passo_atual='Aguardando 1ª abordagem' (entra na fila do funil).

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
    CASE
      WHEN d.status IN ('Cobrar','Fazer ação') THEN 'Aguardando 1ª abordagem'::text
      ELSE NULL::text
    END) AS passo_atual,
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
    OR d.status = ANY (ARRAY[
      'Cobrar'::text, 'Fazer ação'::text,
      'Em contato'::text, 'Em negociação'::text,
      'Acordo'::text, 'Ação judicial'::text
    ])
  );
