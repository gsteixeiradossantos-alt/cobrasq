-- 20260924a_casos_whitelist_status_sem_numero
-- PASSO 1 de 3 da limpeza dos status numerados (pedido do Gustavo, 24/09/2026).
--
-- A view `casos` (fonte única do CRM) filtra por uma LISTA BRANCA de status. Tirar o
-- número da frente de "3. Cumprimento de Sentença" & cia. DIRETO na tabela, sem passar
-- por aqui antes, faria 433 dos 467 casos ativos sumirem do CRM — e a Bia passaria a
-- responder ao credor "não encontrei esse caso" (mesma armadilha do `fora_crm`,
-- documentada no CLAUDE.md).
--
-- Esta migração só ACRESCENTA as grafias sem número à lista. Os nomes numerados
-- continuam aceitos, então a view fica correta ANTES, DURANTE e DEPOIS do rename dos
-- dados (20260924b) — nenhum caso pisca fora do CRM em nenhum instante.
--
-- Grafias que já estavam na lista e por isso não aparecem aqui: 'Quitado' (ex-"5.
-- Quitado"), 'Devolvida' (ex-"8. Devolvida") e 'Reajuizar' (ex-"7. Reajuizar").
--
-- Idempotente; mesmo padrão de 20260803_casos_whitelist_etiquetas_novas.sql.
-- Re-declara WITH (security_invoker = true) — guarda anti-drift F-04.
DO $$
DECLARE def text; novo text;
BEGIN
  SELECT pg_get_viewdef('public.casos'::regclass, true) INTO def;
  def := regexp_replace(def, ';\s*$', '');
  IF position('''Cumprimento de Sentença''::text' in def) = 0 THEN
    novo := replace(
      def,
      ', ''Devolver''::text]',
      ', ''Devolver''::text'
        || ', ''Ação de Cobrança''::text'
        || ', ''Ação de locupletamento ilícito''::text'
        || ', ''Ação Monitória''::text'
        || ', ''Acordo Extrajudicial''::text'
        || ', ''Acordo Judicial''::text'
        || ', ''Cumprimento de Sentença''::text'
        || ', ''Ação de Execução de Título Extrajudicial''::text'
        || ', ''Automatizar Micro''::text'
        || ', ''Baixados''::text'
        || ', ''Encerrada''::text]'
    );
    IF novo = def THEN
      RAISE EXCEPTION 'ancora '', ''''Devolver''''::text]'' nao encontrada na viewdef — abortando sem alterar a view';
    END IF;
    EXECUTE 'CREATE OR REPLACE VIEW public.casos WITH (security_invoker = true) AS ' || novo;
  END IF;
END $$;
