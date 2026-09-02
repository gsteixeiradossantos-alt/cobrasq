-- Status "Executar acordo": inclui a etiqueta no whitelist de status da view `casos`.
--
-- Sem isto, uma cobrança marcada como "Executar acordo" e SEM passo_atual desaparece
-- do CRM em silêncio — o WHERE da view só deixa passar caso com passo_atual, ou
-- encerramento, ou origem de migração, ou status pertencente a um array fixo.
-- Foi o que aconteceu com a cobrança de Andrelina Marca Lembeck (a817c664), cujo
-- acordo extrajudicial deixou de ser cumprido em 02/09/2026.
--
-- Mesma estratégia de 20260630_casos_view_etiquetas.sql: pega a definição VIVA
-- (pg_get_viewdef), amplia SÓ o array de status do WHERE e recria com CREATE OR
-- REPLACE VIEW, preservando colunas, os triggers INSTEAD OF e security_invoker.
-- Idempotente: se a etiqueta já estiver lá, não faz nada.
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
    $old$'Para protocolar'::text]$old$,
    $new$'Para protocolar'::text, 'Executar acordo'::text]$new$
  );

  IF newdef = def THEN
    RAISE EXCEPTION 'casos view: âncora do whitelist não encontrada — abortando para não recriar errado';
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.casos WITH (security_invoker = true) AS ' || newdef;
END
$mig$;
