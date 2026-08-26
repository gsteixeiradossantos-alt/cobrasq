-- 20260826_casos_whitelist_orto_suspensa
-- Etiqueta nova "Orto suspensa" (carteira Odontomundi: tratamento ortodôntico interrompido,
-- cobrança segue viva). A view `casos` filtra por lista branca de status: sem esta entrada,
-- a cobrança some do CRM sem erro — mesmo problema de 20260803_casos_whitelist_etiquetas_novas.
-- Aplicada em produção em 26/08/2026 (caso c26bf7fb, Aline Vitória / Eduardo José Mallmom);
-- este arquivo registra a migração no repo. Idempotente: não reaplica se a etiqueta já está lá.
DO $$
DECLARE def text; novo text;
BEGIN
  SELECT pg_get_viewdef('public.casos'::regclass, true) INTO def;
  def := regexp_replace(def, ';\s*$', '');
  IF position('Orto suspensa' in def) = 0 THEN
    novo := replace(
      def,
      '''4. Ação Monitória''::text]',
      '''4. Ação Monitória''::text, ''Orto suspensa''::text]'
    );
    IF novo = def THEN
      RAISE EXCEPTION 'ancora ''4. Ação Monitória'' nao encontrada na viewdef — abortando sem alterar a view';
    END IF;
    EXECUTE 'CREATE OR REPLACE VIEW public.casos WITH (security_invoker = true) AS ' || novo;
  END IF;
END $$;
