-- 20260915_casos_whitelist_devolver
-- A view `casos` (fonte do CRM) filtra por uma lista branca de status. O status
-- `Devolver` (cobrança física separada para devolução do documento ao cliente,
-- usado pela skill revisar-carteira-cobrasq) nunca entrou na lista — toda
-- cobrança que vira `Devolver` some do CRM/da Bia com a cobrança íntegra em
-- `cobrancas`, sem erro nenhum.
-- Achado em 14/09/2026 (sessão Posto Sulina) e confirmado de novo em 15/09/2026
-- na vistoria da carteira Mercado Colina: 126 cobranças ativas com status
-- `Devolver` no banco inteiro contra 1 só aparecendo em `casos`.
-- Acrescenta a etiqueta faltante à lista, preservando o resto da definição
-- (idempotente, mesmo padrão de 20260803_casos_whitelist_etiquetas_novas.sql).
DO $$
DECLARE def text; novo text;
BEGIN
  SELECT pg_get_viewdef('public.casos'::regclass, true) INTO def;
  def := regexp_replace(def, ';\s*$', '');
  IF position('''Devolver''::text' in def) = 0 THEN
    novo := replace(
      def,
      '''Telefone inválido''::text]',
      '''Telefone inválido''::text, ''Devolver''::text]'
    );
    IF novo = def THEN
      RAISE EXCEPTION 'ancora ''Telefone inválido'' nao encontrada na viewdef — abortando sem alterar a view';
    END IF;
    EXECUTE 'CREATE OR REPLACE VIEW public.casos WITH (security_invoker = true) AS ' || novo;
  END IF;
END $$;
