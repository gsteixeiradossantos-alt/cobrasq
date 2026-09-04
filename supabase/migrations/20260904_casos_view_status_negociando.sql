-- Status "Negociando" e "Quitado ao cliente": inclui as duas etiquetas no whitelist
-- de status da view `casos`.
--
-- Sem isto, a cobrança com esse status e SEM passo_atual desaparece do CRM em
-- silêncio — o WHERE da view só deixa passar caso com passo_atual, ou encerramento,
-- ou origem de migração, ou status pertencente a um array fixo. Como a view é o que a
-- Bia e o Carlos leem (bia-atendimento, beatriz-msg) e o que o assistente de petição
-- consulta, o caso invisível ali é caso que a IA trata como inexistente quando o
-- devedor escreve. Mesmo desaparecimento da cobrança de Andrelina Marca Lembeck, que
-- motivou 20260902_casos_view_status_executar_acordo.sql.
--
-- Motivo agora: "Negociando" voltou a ser etapa do painel (#651) e passou a ser
-- gravado quando se abre negociação com o devedor (skill negociacao-cobrasq) — ou
-- seja, exatamente nos casos em que a conversa está viva e a Bia mais precisa
-- enxergar. Em 04/09/2026 havia 3 casos assim (Vanessa dos Santos Vaz, Robson
-- Marcello, Stefani Caroline) já invisíveis. "Quitado ao cliente" entra junto: são
-- 27 casos encerrados que a Bia também não reconhecia.
--
-- Estratégia (mesma de 20260902 e 20260630_casos_view_etiquetas.sql): pega a
-- definição VIVA (pg_get_viewdef), amplia SÓ o array de status do WHERE e recria com
-- CREATE OR REPLACE VIEW, preservando colunas, os triggers INSTEAD OF e
-- security_invoker.
--
-- Âncora: 'Hasta pública'::text, — no MEIO do array, só existe nele (o outro ARRAY de
-- status da view, o do CASE de passo_atual, não a contém) e não se move quando
-- etiquetas novas entram no fim. Ancorar no fecho do array foi o que quebrou a
-- migração de #628.
--
-- Idempotente por etiqueta: cada uma é inserida só se ainda não estiver lá, então
-- rodar de novo (ou rodar com uma das duas já aplicada) é inócuo.
DO $mig$
DECLARE
  def     text;
  newdef  text;
  etiq    text;
  add     text[] := ARRAY['Negociando', 'Quitado ao cliente'];
  mudou   boolean := false;
BEGIN
  def := pg_get_viewdef('public.casos'::regclass, true);
  newdef := def;

  FOREACH etiq IN ARRAY add LOOP
    IF newdef LIKE '%''' || etiq || '''::text%' THEN
      RAISE NOTICE 'casos view: "%" já está no whitelist — pulando', etiq;
      CONTINUE;
    END IF;

    newdef := replace(
      newdef,
      $old$'Hasta pública'::text,$old$,
      $new$'Hasta pública'::text, $new$ || quote_literal(etiq) || $new$::text,$new$
    );
    mudou := true;
  END LOOP;

  IF NOT mudou THEN
    RAISE NOTICE 'casos view: nada a fazer';
    RETURN;
  END IF;

  IF newdef = def THEN
    RAISE EXCEPTION 'casos view: âncora do whitelist não encontrada — abortando para não recriar errado';
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.casos WITH (security_invoker = true) AS ' || newdef;
END
$mig$;
