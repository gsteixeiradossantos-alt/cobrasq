-- 20260709_casos_fora_crm_rollback
-- Reverte a coluna fora_crm e remove o filtro da view casos.

-- 1) Recria a view casos removendo o AND do fora_crm (idempotente).
DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_viewdef('public.casos'::regclass, true) INTO def;
  def := regexp_replace(def, ';\s*$', '');
  def := regexp_replace(def, '\s*AND NOT COALESCE\(co\.fora_crm, false\)', '', 'g');
  EXECUTE 'CREATE OR REPLACE VIEW public.casos WITH (security_invoker = true) AS ' || def;
END $$;

-- 2) Remove indice e coluna.
DROP INDEX IF EXISTS public.idx_cobrancas_fora_crm;
ALTER TABLE public.cobrancas DROP COLUMN IF EXISTS fora_crm;
