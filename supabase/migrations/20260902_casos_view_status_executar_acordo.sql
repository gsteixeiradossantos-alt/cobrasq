-- Status "Executar acordo": inclui a etiqueta no whitelist de status da view `casos`.
--
-- Sem isto, uma cobrança marcada como "Executar acordo" e SEM passo_atual desaparece
-- do CRM em silêncio — o WHERE da view só deixa passar caso com passo_atual, ou
-- encerramento, ou origem de migração, ou status pertencente a um array fixo.
-- Foi o que aconteceu com a cobrança de Andrelina Marca Lembeck (a817c664), cujo
-- acordo extrajudicial deixou de ser cumprido em 02/09/2026.
--
-- Estratégia (mesma de 20260630_casos_view_etiquetas.sql): pega a definição VIVA
-- (pg_get_viewdef), amplia SÓ o array de status do WHERE e recria com CREATE OR
-- REPLACE VIEW, preservando colunas, os triggers INSTEAD OF e security_invoker.
--
-- ATENÇÃO À ÂNCORA. A versão anterior deste arquivo ancorava em
-- $$'Para protocolar'::text]$$, isto é, no ÚLTIMO item do array. Isso quebrou: entre
-- 30/06 e 02/09/2026 o whitelist recebeu mais 8 etiquetas ('Quita Fácil',
-- 'Quita Fácil Judicial', 'Reajuizar de bens', '4. Ação Monitória', 'Orto suspensa',
-- 'Acordo enviado', 'Reajuizar', 'Reajuizar - Cessão') e o fecho do array deixou de
-- ser aquele. Ancorar no fim é frágil por construção.
-- Aqui a âncora é 'Hasta pública'::text, que fica no MEIO do array, só existe nele
-- (o outro ARRAY de status da view, o do CASE de passo_atual, não a contém) e não se
-- move quando etiquetas novas são acrescentadas ao fim.
DO $mig$
DECLARE
  def text;
  newdef text;
BEGIN
  def := pg_get_viewdef('public.casos'::regclass, true);

  IF def LIKE '%''Executar acordo''::text%' THEN
    RAISE NOTICE 'casos view: "Executar acordo" já está no whitelist — nada a fazer';
    RETURN;
  END IF;

  newdef := replace(
    def,
    $old$'Hasta pública'::text,$old$,
    $new$'Hasta pública'::text, 'Executar acordo'::text,$new$
  );

  IF newdef = def THEN
    RAISE EXCEPTION 'casos view: âncora do whitelist não encontrada — abortando para não recriar errado';
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.casos WITH (security_invoker = true) AS ' || newdef;
END
$mig$;
