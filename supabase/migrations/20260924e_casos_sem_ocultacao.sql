-- 20260924e_casos_sem_ocultacao
-- Pedido do Gustavo, 24/09/2026: "nao quero mais cobrancas ocultas no sistema" —
-- "sistema de modo geral", e a escolha foi "Nao — nada mais some".
--
-- A view `casos` (fonte unica do CRM, da Bia e do peticionamento) escondia a cobranca
-- em tres situacoes, sem aviso nenhum na tela: arquivado=true, is_draft=true e
-- fora_crm=true. Eram 169 de 1062 cobrancas invisiveis (91 arquivadas, 72 fora_crm,
-- 6 rascunho) — e a Bia respondia ao credor "nao encontrei esse caso" para todas elas.
--
-- Esta migracao REMOVE esse WHERE de ocultacao e EXPOE as tres flags como colunas, para
-- que a tela possa marcar o caso como arquivado/rascunho/fora do CRM em vez de sumir com
-- ele. Nada e apagado. Tambem expoe status/etapa/numero_processo, que a view nao trazia.
--
-- Idempotente (se a coluna `arquivado` ja existir na view, nao faz nada) e aborta sem
-- alterar coisa alguma se a ancora nao for encontrada.
-- Re-declara WITH (security_invoker = true) — guarda anti-drift F-04.
DO $mig$
DECLARE def text; corpo text; p int;
BEGIN
  SELECT pg_get_viewdef('public.casos'::regclass, true) INTO def;
  def := regexp_replace(def, ';\s*$', '');
  p := position(' WHERE NOT COALESCE(co.arquivado' in def);
  IF p = 0 THEN
    IF position('co.arquivado AS arquivado' in def) > 0 THEN RETURN; END IF;
    RAISE EXCEPTION 'WHERE de ocultacao nao encontrado na viewdef — abortando sem alterar a view';
  END IF;
  corpo := left(def, p - 1);
  IF position('co.carlos_ativo' in corpo) = 0 THEN
    RAISE EXCEPTION 'ancora co.carlos_ativo nao encontrada — abortando sem alterar a view';
  END IF;
  corpo := replace(corpo, '    co.carlos_ativo',
                          '    co.carlos_ativo,'
                       || E'\n    COALESCE(co.arquivado, false) AS arquivado,'
                       || E'\n    COALESCE(co.is_draft, false) AS is_draft,'
                       || E'\n    COALESCE(co.fora_crm, false) AS fora_crm,'
                       || E'\n    co.status,'
                       || E'\n    co.etapa,'
                       || E'\n    co.numero_processo');
  EXECUTE 'CREATE OR REPLACE VIEW public.casos WITH (security_invoker = true) AS ' || corpo;
END $mig$;
