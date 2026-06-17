-- 20260617_06_merge_clientes_duplicados.sql
-- ----------------------------------------------------------------------------
-- Mescla de clientes (credores) duplicados pelo mesmo CNPJ. Aplicado em prod via
-- MCP em 2026-06-17 (este arquivo é o registro canônico).
--
-- CONTEXTO: existiam cadastros duplicados de credor com o mesmo CNPJ. O modal
-- (salvarCliente) hoje bloqueia por doc, mas (a) não havia constraint no banco e
-- (b) os duplicados foram criados antes desse bloqueio. Ver tb. a trava em
-- 20260617_07_clientes_doc_digits_unique.sql.
--
-- GRUPO 1 — Cecato Clinica Veterinaria Ltda (CNPJ 39.513.779/0001-84):
--   vencedor df15130b-…3b644 (mais antigo, 21 devedores + 18 cobranças)
--   perdedor 0e148b44-…05df3f (5 devedores + 7 cobranças) -> repontado e removido.
--   (dados idênticos entre os dois; nada a preservar.)
-- GRUPO 2 — COBRASQ (CNPJ 34.626.848/0001-42, o próprio escritório, 0 vínculos):
--   mantém c7a69872 ativo; arquiva o extra 07e5b946 (bba82693 já estava arquivado).
--
-- FKs de cliente_id são ON DELETE SET NULL/CASCADE; por isso repontamos TODOS os
-- filhos do perdedor para o vencedor ANTES de excluir. Preserva ordem do array no blob.
--
-- IMPORTANTE (F-01): quem estiver com o app aberto deve dar REFRESH; a trava do
-- 07 impede que um save() de sessão antiga recrie o perdedor (mesmo CNPJ ativo).
-- Rollback: 20260617_06_merge_clientes_duplicados_rollback.sql
-- ----------------------------------------------------------------------------

BEGIN;

-- Cecato: repointar filhos do perdedor (0e148b44) -> vencedor (df15130b)
UPDATE public.devedores            SET cliente_id='df15130b-5d30-46a8-a00c-30d70e93b644' WHERE cliente_id='0e148b44-541d-45e0-8b3c-03183405df3f';
UPDATE public.cobrancas            SET cliente_id='df15130b-5d30-46a8-a00c-30d70e93b644' WHERE cliente_id='0e148b44-541d-45e0-8b3c-03183405df3f';
UPDATE public.cliente_documentos   SET cliente_id='df15130b-5d30-46a8-a00c-30d70e93b644' WHERE cliente_id='0e148b44-541d-45e0-8b3c-03183405df3f';
UPDATE public.fin_custodia_judicial SET cliente_id='df15130b-5d30-46a8-a00c-30d70e93b644' WHERE cliente_id='0e148b44-541d-45e0-8b3c-03183405df3f';
UPDATE public.fin_operacao         SET credor_id='df15130b-5d30-46a8-a00c-30d70e93b644' WHERE credor_id='0e148b44-541d-45e0-8b3c-03183405df3f';
UPDATE public.ag_conversations     SET cliente_id='df15130b-5d30-46a8-a00c-30d70e93b644' WHERE cliente_id='0e148b44-541d-45e0-8b3c-03183405df3f';
UPDATE public.ag_config            SET cliente_id='df15130b-5d30-46a8-a00c-30d70e93b644' WHERE cliente_id='0e148b44-541d-45e0-8b3c-03183405df3f';
UPDATE public.ag_kb_chunks         SET cliente_id='df15130b-5d30-46a8-a00c-30d70e93b644' WHERE cliente_id='0e148b44-541d-45e0-8b3c-03183405df3f';
UPDATE public.ag_negotiation_rules SET cliente_id='df15130b-5d30-46a8-a00c-30d70e93b644' WHERE cliente_id='0e148b44-541d-45e0-8b3c-03183405df3f';

DELETE FROM public.clientes WHERE id='0e148b44-541d-45e0-8b3c-03183405df3f';

-- COBRASQ: arquivar o extra ativo (mantém c7a69872)
UPDATE public.clientes
SET arquivado=true, arquivado_em=now(),
    arquivado_motivo='Duplicado do mesmo CNPJ (mantido c7a69872) — colapsado 2026-06-17'
WHERE id='07e5b946-6719-4221-8b0a-b2382b5256a1' AND arquivado=false;

-- BLOB cobrasq_data: repointar clienteId dos devedores e remover o cliente perdedor
UPDATE public.cobrasq_data
SET data = jsonb_set(
  jsonb_set(
    data, '{devedores}',
    (SELECT jsonb_agg(
       CASE WHEN e.val->>'clienteId'='0e148b44-541d-45e0-8b3c-03183405df3f'
            THEN e.val || jsonb_build_object('clienteId','df15130b-5d30-46a8-a00c-30d70e93b644')
            ELSE e.val END ORDER BY e.ord)
     FROM jsonb_array_elements(data->'devedores') WITH ORDINALITY AS e(val,ord))
  ),
  '{clientes}',
  (SELECT jsonb_agg(e.val ORDER BY e.ord)
   FROM jsonb_array_elements(data->'clientes') WITH ORDINALITY AS e(val,ord)
   WHERE e.val->>'id' <> '0e148b44-541d-45e0-8b3c-03183405df3f')
),
updated_at=now()
WHERE key='main';

COMMIT;
