-- 20260803_casos_whitelist_etiquetas_novas
-- A view `casos` (fonte do CRM) filtra por uma lista branca de status. Etiquetas criadas
-- depois da lista ficam invisíveis no CRM mesmo com a cobrança íntegra em `cobrancas`.
-- Achado em 03/08/2026 no import do Machadinho Auto Center: 7 casos do lote + 10 anteriores
-- sumidos (7 "Quita Fácil" do lote de 26/07 e 3 "4. Ação Monitória").
-- Acrescenta as etiquetas faltantes à lista, preservando o resto da definição (idempotente,
-- mesmo padrão de 20260709_casos_fora_crm.sql).
--
-- ATENÇÃO ao criar etiqueta nova: Configurações → Etiquetas mexe só em DB.config.etiquetas
-- (seletor da tela). Se a etiqueta não entrar TAMBÉM nesta lista branca, a cobrança some do CRM.
DO $$
DECLARE def text; novo text;
BEGIN
  SELECT pg_get_viewdef('public.casos'::regclass, true) INTO def;
  def := regexp_replace(def, ';\s*$', '');
  IF position('Reajuizar de bens' in def) = 0 THEN
    novo := replace(
      def,
      '''Para protocolar''::text]',
      '''Para protocolar''::text, ''Quita Fácil''::text, ''Quita Fácil Judicial''::text, ''Reajuizar de bens''::text, ''4. Ação Monitória''::text]'
    );
    IF novo = def THEN
      RAISE EXCEPTION 'ancora ''Para protocolar'' nao encontrada na viewdef — abortando sem alterar a view';
    END IF;
    EXECUTE 'CREATE OR REPLACE VIEW public.casos WITH (security_invoker = true) AS ' || novo;
  END IF;
END $$;
