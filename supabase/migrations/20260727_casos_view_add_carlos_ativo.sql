-- JÁ APLICADO EM PROD (versão 20260727033751). Snapshot reconstruído do catálogo em 2026-07-29. NÃO rodar db push.
-- ============================================================================
-- Recria a view public.casos acrescentando a coluna co.carlos_ativo (flag do
-- Carlos, IA de negociação — ver 20260727_carlos_ativo_flag.sql).
--
-- Nenhuma migração de 29/07 no repo redefine o CORPO da view (a
-- 20260729_f04_casos_security_invoker.sql só faz ALTER VIEW ... SET
-- (security_invoker = true)), então este arquivo captura a definição ATUAL
-- completa via pg_get_viewdef('public.casos') em 2026-07-29 — já COM
-- carlos_ativo e COM security_invoker=true (reloptions atuais; o
-- security_invoker em si foi aplicado pela migração F-04 de 29/07, não por
-- esta). Atenção: ao recriar esta view no futuro, preservar o
-- security_invoker=true (regressão F-04 — foi exatamente esta migração de
-- 27/07 que o derrubou ao recriar a view sem a opção).
-- ============================================================================

CREATE OR REPLACE VIEW public.casos
WITH (security_invoker = true) AS
 SELECT co.id,
    co.assigned_to AS created_by,
    co.assigned_to,
    d.nome AS devedor,
    d.telefone,
    d.doc AS documento,
    co.cliente_id,
    COALESCE(c.nome_fantasia, c.nome, co.metadata ->> 'credorOriginal'::text) AS credor,
    c.nome AS credor_razao_social,
    c.doc AS credor_doc,
    TRIM(BOTH ', '::text FROM (((((COALESCE(c.rua, ''::text) ||
        CASE
            WHEN c.numero IS NOT NULL AND c.numero <> ''::text THEN ', n. '::text || c.numero
            ELSE ''::text
        END) ||
        CASE
            WHEN c.complemento IS NOT NULL AND c.complemento <> ''::text THEN ', '::text || c.complemento
            ELSE ''::text
        END) ||
        CASE
            WHEN c.bairro IS NOT NULL AND c.bairro <> ''::text THEN ', '::text || c.bairro
            ELSE ''::text
        END) ||
        CASE
            WHEN c.cidade IS NOT NULL AND c.cidade <> ''::text THEN ', '::text || c.cidade
            ELSE ''::text
        END) ||
        CASE
            WHEN c.uf IS NOT NULL AND c.uf <> ''::text THEN ' — '::text || c.uf
            ELSE ''::text
        END) ||
        CASE
            WHEN c.cep IS NOT NULL AND c.cep <> ''::text THEN ', CEP '::text || c.cep
            ELSE ''::text
        END) AS credor_endereco,
    c.cidade AS credor_cidade,
    TRIM(BOTH ', '::text FROM (((((COALESCE(d.rua, ''::text) ||
        CASE
            WHEN d.numero IS NOT NULL AND d.numero <> ''::text THEN ', n. '::text || d.numero
            ELSE ''::text
        END) ||
        CASE
            WHEN d.complemento IS NOT NULL AND d.complemento <> ''::text THEN ', '::text || d.complemento
            ELSE ''::text
        END) ||
        CASE
            WHEN d.bairro IS NOT NULL AND d.bairro <> ''::text THEN ', '::text || d.bairro
            ELSE ''::text
        END) ||
        CASE
            WHEN d.cidade IS NOT NULL AND d.cidade <> ''::text THEN ', '::text || d.cidade
            ELSE ''::text
        END) ||
        CASE
            WHEN d.uf IS NOT NULL AND d.uf <> ''::text THEN ' — '::text || d.uf
            ELSE ''::text
        END) ||
        CASE
            WHEN d.cep IS NOT NULL AND d.cep <> ''::text THEN ', CEP '::text || d.cep
            ELSE ''::text
        END) AS endereco,
    COALESCE(co.valor_orig::numeric, safe_numeric(co.divida ->> 'valorOriginal'::text), safe_numeric(co.divida ->> 'valor_original'::text), safe_numeric(co.divida ->> 'totalAvista'::text)) AS valor_orig,
    COALESCE(co.valor_atual::numeric, safe_numeric(co.divida ->> 'totalAvista'::text), safe_numeric(co.divida ->> 'valorAtual'::text)) AS valor_atual,
    COALESCE(safe_date(co.divida ->> 'vencimento'::text), safe_date(co.metadata ->> 'vencimento'::text), co.data_entrada) AS divida_vencimento,
    COALESCE(co.metadata ->> 'titulo'::text, co.divida ->> 'descricao'::text, co.divida ->> 'titulo'::text) AS divida_descricao,
    COALESCE(co.divida, '{}'::jsonb) AS divida,
    COALESCE(co.passo_atual,
        CASE
            WHEN co.status = ANY (ARRAY['Cobrar'::text, 'Fazer ação'::text, 'Notificação enviada'::text, 'Petição inicial'::text]) THEN 'Aguardando 1ª abordagem'::text
            ELSE NULL::text
        END) AS passo_atual,
    COALESCE(co.aguardando_resposta, false) AS aguardando_resposta,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object('quando', devedor_eventos.criado_em, 'acao', COALESCE(devedor_eventos.payload ->> 'acao_completa'::text, devedor_eventos.payload ->> 'acao'::text, devedor_eventos.payload ->> 'texto'::text, devedor_eventos.payload ->> 'descricao'::text, devedor_eventos.payload ->> 'mensagem'::text, devedor_eventos.tipo)) ORDER BY devedor_eventos.criado_em) AS jsonb_agg
           FROM devedor_eventos
          WHERE devedor_eventos.devedor_id = co.id), '[]'::jsonb) AS historico,
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
    COALESCE(( SELECT jsonb_agg(jsonb_build_object('devedor_id', p.devedor_id, 'papel', p.papel, 'principal', p.principal, 'nome', pd.nome, 'doc', pd.doc, 'telefone', pd.telefone) ORDER BY p.principal DESC, p.created_at) AS jsonb_agg
           FROM cobranca_partes p
             JOIN devedores pd ON pd.id = p.devedor_id
          WHERE p.cobranca_id = co.id), '[]'::jsonb) AS partes,
    co.carlos_ativo
   FROM cobrancas co
     LEFT JOIN cobranca_partes pp ON pp.cobranca_id = co.id AND pp.principal
     LEFT JOIN devedores d ON d.id = pp.devedor_id
     LEFT JOIN clientes c ON c.id = co.cliente_id
  WHERE NOT COALESCE(co.arquivado, false) AND (co.passo_atual IS NOT NULL OR co.encerramento IS NOT NULL OR (co.metadata ->> 'origem'::text) = 'migracao_crm_2026-05-08'::text OR (co.status = ANY (ARRAY['Cobrar'::text, 'Fazer ação'::text, 'Em contato'::text, 'Em negociação'::text, 'Acordo'::text, 'Ação judicial'::text, 'Recebido'::text, 'Quitado'::text, 'Notificação enviada'::text, 'Proposta enviada'::text, 'Acordo firmado'::text, 'Em pagamento'::text, 'Devolvida'::text, 'Sem êxito'::text, 'Petição inicial'::text, 'Citação'::text, 'Contestação'::text, 'Audiência'::text, 'Sentença'::text, 'Recurso'::text, 'Execução'::text, 'Penhora'::text, 'Hasta pública'::text, 'Encerrado'::text, '1. Ação de Cobrança'::text, '1.1 Ação de locupletamento ilícito'::text, '1.2. Ação Monitória'::text, '2. Acordo Extrajudicial'::text, '2.1. Acordo Judicial'::text, '3. Cumprimento de Sentença'::text, '4. Ação de Execução de Título Extrajudicial'::text, '10. Automatizar Micro'::text, '5. Quitado'::text, '6. Baixados'::text, '7. Reajuizar'::text, '8. Devolvida'::text, '9. Encerrada'::text, 'Análise'::text, 'Baixar'::text, 'Em andamento'::text, 'Para protocolar'::text]))) AND NOT COALESCE(co.is_draft, false) AND NOT COALESCE(co.fora_crm, false);
