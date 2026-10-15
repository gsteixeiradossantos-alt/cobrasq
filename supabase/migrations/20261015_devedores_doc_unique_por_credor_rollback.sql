-- Rollback de 20261015_devedores_doc_unique_por_credor.sql: volta a unicidade global do CPF.
-- Antes, conferir se há o mesmo doc em dois credores (o CREATE falha se houver):
--   select doc_digits, count(*) from public.devedores
--    where doc_digits is not null and doc_digits <> ''
--      and not coalesce(arquivado,false) and coalesce(is_draft,false) = false
--    group by 1 having count(*) > 1;

DROP INDEX IF EXISTS public.idx_devedores_doc_digits_unique;

CREATE UNIQUE INDEX idx_devedores_doc_digits_unique
  ON public.devedores (doc_digits)
  WHERE doc_digits IS NOT NULL
    AND doc_digits <> ''
    AND NOT COALESCE(arquivado, false)
    AND COALESCE(is_draft, false) = false;
