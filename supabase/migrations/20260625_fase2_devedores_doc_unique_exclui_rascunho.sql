-- Fase 2 (2026-06-25): a trava de CPF/CNPJ único dos DEVEDORES passa a EXCLUIR rascunhos,
-- espelhando o índice de clientes (idx_clientes_doc_digits_unique).
--
-- Motivo: um rascunho/auto-save com um CPF preenchido ocupava o índice e BLOQUEAVA o
-- cadastro real de um devedor com o mesmo CPF — porém o rascunho fica escondido das listas
-- (filtro !isDraft), gerando o sintoma "diz que o CPF já existe mas não aparece ninguém".
-- O índice antigo só excluía arquivados; agora exclui também is_draft=true.
--
-- Seguro: o índice novo cobre um SUBCONJUNTO das linhas do antigo (menos restritivo em
-- cobertura), então não pode falhar por duplicidade existente. Verificado em 2026-06-25:
-- 0 doc_digits duplicado entre devedores ativos e não-rascunho.

DROP INDEX IF EXISTS public.idx_devedores_doc_digits_unique;

CREATE UNIQUE INDEX idx_devedores_doc_digits_unique
  ON public.devedores (doc_digits)
  WHERE doc_digits IS NOT NULL
    AND doc_digits <> ''
    AND NOT COALESCE(arquivado, false)
    AND COALESCE(is_draft, false) = false;
