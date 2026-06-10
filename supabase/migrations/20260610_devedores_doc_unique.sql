-- PR-F: bloqueio de duplicação de CPF/CNPJ em devedores.
-- Regra: 1 devedor por CPF/CNPJ no sistema, com N dívidas via "Dívidas adicionais".
-- Frontend valida antes; este UNIQUE INDEX é a rede de segurança contra
-- corridas e bypass.
--
-- Detalhes:
-- - Coluna gerada `doc_digits` derivada de `doc` (só dígitos).
-- - UNIQUE parcial: aplica quando doc preenchido E devedor não-arquivado.
--   Devedores arquivados podem coexistir (devedor reativado depois).

ALTER TABLE public.devedores
  ADD COLUMN IF NOT EXISTS doc_digits text
  GENERATED ALWAYS AS (regexp_replace(COALESCE(doc, ''), '\D', '', 'g')) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS idx_devedores_doc_digits_unique
  ON public.devedores(doc_digits)
  WHERE doc_digits IS NOT NULL
    AND doc_digits <> ''
    AND NOT COALESCE(arquivado, false);

COMMENT ON COLUMN public.devedores.doc_digits IS
  'CPF/CNPJ só dígitos. Usado pelo idx_devedores_doc_digits_unique pra bloquear duplicação.';
