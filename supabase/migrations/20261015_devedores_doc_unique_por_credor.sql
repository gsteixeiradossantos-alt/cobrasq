-- 2026-10-15: o CPF/CNPJ do devedor passa a ser único POR CREDOR, não no sistema todo.
--
-- Motivo: a mesma pessoa pode dever a dois credores (ex.: Douglas, devedor da Oxipar com
-- processo 0001143-86.2025.8.16.0079 e agora também na carteira da Master). O índice antigo,
-- único em (doc_digits), barrava a 2ª ficha; o contorno era criar a ficha com doc=null e
-- guardar o CPF em metadata.obs — o que tira a ficha da busca por CPF, do Asaas e da Bia.
--
-- Agora: único em (cliente_id, doc_digits). NULLS NOT DISTINCT faz os devedores sem credor
-- (cliente_id null) continuarem únicos entre si, como antes. Mesmo filtro do índice anterior
-- (exclui arquivado e rascunho — ver 20260625_fase2_devedores_doc_unique_exclui_rascunho.sql).
--
-- Seguro: o índice novo é menos restritivo que o antigo (todo par (cliente_id, doc) único
-- já era único só pelo doc), então não pode falhar por duplicidade existente.
-- Rollback: 20261015_devedores_doc_unique_por_credor_rollback.sql — FALHA se já houver o
-- mesmo CPF em dois credores; nesse caso, resolver as duplicatas antes.

DROP INDEX IF EXISTS public.idx_devedores_doc_digits_unique;

CREATE UNIQUE INDEX idx_devedores_doc_digits_unique
  ON public.devedores (cliente_id, doc_digits) NULLS NOT DISTINCT
  WHERE doc_digits IS NOT NULL
    AND doc_digits <> ''
    AND NOT COALESCE(arquivado, false)
    AND COALESCE(is_draft, false) = false;
