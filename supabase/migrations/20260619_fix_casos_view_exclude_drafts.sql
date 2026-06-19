-- 20260619_fix_casos_view_exclude_drafts
-- Aplicada em produção via MCP em 2026-06-19 (registro/reprodutibilidade).
--
-- Contexto: a view `casos` (fonte única do CRM/crm.html) filtrava apenas
-- `arquivado` + status, mas NÃO excluía rascunhos (is_draft). Resultado: casos
-- marcados como rascunho apareciam no CRM. Parte do conserto do "rascunho-fantasma"
-- (o carimbo de rascunho vivia no metadata de devedores E cobrancas; agora a coluna
-- is_draft é a fonte única — ver index.html devedorToRow/rowToDevedor).
--
-- Recria a view a partir da definição viva, anexando `AND NOT COALESCE(co.is_draft,false)`
-- e mantendo WITH (security_invoker = true) (guarda anti-drift F-04). Idempotente.
DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_viewdef('public.casos'::regclass, true) INTO def;
  def := regexp_replace(def, ';\s*$', '');
  IF position('is_draft' in def) = 0 THEN
    EXECUTE 'CREATE OR REPLACE VIEW public.casos WITH (security_invoker = true) AS '
            || def || E'\n  AND NOT COALESCE(co.is_draft, false)';
  ELSE
    EXECUTE 'CREATE OR REPLACE VIEW public.casos WITH (security_invoker = true) AS ' || def;
  END IF;
END $$;
