-- 20260924d_casos_whitelist_quitado_direto_credor
-- A etiqueta "Quitado direto ao credor" (devedor pagou direto ao credor) entrou no
-- seletor do index.html sem entrar na lista branca da view `casos`. Resultado medido em
-- 24/09/2026: dos 7 casos com esse status, 6 estavam INVISÍVEIS no CRM — a Bia responde
-- ao credor "não encontrei esse caso" e petição/sugestão de resposta dão 403 pra eles.
-- Mesma armadilha de 20260803 e de 20260924a.
--
-- Idempotente. Re-declara WITH (security_invoker = true) — guarda anti-drift F-04.
DO $$
DECLARE def text; novo text;
BEGIN
  SELECT pg_get_viewdef('public.casos'::regclass, true) INTO def;
  def := regexp_replace(def, ';\s*$', '');
  IF position('''Quitado direto ao credor''::text' in def) = 0 THEN
    novo := replace(def, ', ''Devolver''::text',
                         ', ''Devolver''::text, ''Quitado direto ao credor''::text');
    IF novo = def THEN
      RAISE EXCEPTION 'ancora Devolver nao encontrada na viewdef — abortando sem alterar a view';
    END IF;
    EXECUTE 'CREATE OR REPLACE VIEW public.casos WITH (security_invoker = true) AS ' || novo;
  END IF;
END $$;
