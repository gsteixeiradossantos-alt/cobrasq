-- Etiqueta única (Situação): inclui as 19 etiquetas novas no whitelist de status da
-- view `casos`, senão uma cobrança nova com etiqueta nova (ex.: "1. Ação de Cobrança",
-- "Análise", "Para protocolar", "5. Quitado") — sem passo_atual — SOME do CRM.
--
-- Estratégia segura: pega a definição VIVA (pg_get_viewdef), amplia SÓ o array de
-- status do WHERE e recria com CREATE OR REPLACE VIEW (preserva colunas, os triggers
-- INSTEAD OF fn_casos_insert/update e security_invoker). Idempotente.
DO $mig$
DECLARE
  def text;
  newdef text;
BEGIN
  def := pg_get_viewdef('public.casos'::regclass, true);

  newdef := replace(
    def,
    $old$'Encerrado'::text]$old$,
    $new$'Encerrado'::text, '1. Ação de Cobrança'::text, '1.1 Ação de locupletamento ilícito'::text, '1.2. Ação Monitória'::text, '2. Acordo Extrajudicial'::text, '2.1. Acordo Judicial'::text, '3. Cumprimento de Sentença'::text, '4. Ação de Execução de Título Extrajudicial'::text, '10. Automatizar Micro'::text, '5. Quitado'::text, '6. Baixados'::text, '7. Reajuizar'::text, '8. Devolvida'::text, '9. Encerrada'::text, 'Análise'::text, 'Baixar'::text, 'Em andamento'::text, 'Para protocolar'::text]$new$
  );

  IF newdef = def THEN
    RAISE EXCEPTION 'casos view: âncora do whitelist não encontrada — abortando para não recriar errado';
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.casos WITH (security_invoker = true) AS ' || newdef;
END
$mig$;
