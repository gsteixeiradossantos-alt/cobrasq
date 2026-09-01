-- 20260827_etiqueta_reajuizar_e_cessao
--
-- Duas mudanças no vocabulário de etiquetas, pedidas em 27/08/2026:
--
-- (a) "7. Reajuizar" passa a se chamar "Reajuizar". O prefixo numérico existia para
--     ordenar a lista do Astrea; no COBRASQ ele só polui a tela. 16 cobranças ativas
--     usam o nome antigo e são renomeadas aqui.
-- (b) Nasce "Reajuizar - Cessão", que NÃO é sinônimo do anterior. "Reajuizar" é
--     reajuizar porque o processo morreu (extinção, arquivamento definitivo).
--     "Reajuizar - Cessão" é reajuizar porque o crédito foi cedido e a ação anterior
--     está no nome do CEDENTE — o processo pode estar vivo e ainda assim ser preciso
--     entrar de novo, agora em nome do cessionário. Rito e prova diferentes.
--
-- ORDEM IMPORTA. A view `casos` só inclui a cobrança quando `passo_atual` ou
-- `encerramento` existem, ou quando o status está numa lista branca escrita na própria
-- definição da view. A maioria esmagadora das cobranças ativas está na view SÓ pelo
-- status. Renomear os dados ANTES de a lista branca conhecer "Reajuizar" faria as 16
-- cobranças sumirem do CRM na hora — íntegras no banco, invisíveis na tela, sem erro
-- e sem aviso. Por isso as duas partes vão na MESMA migração, nesta ordem, e no mesmo
-- commit implícito: a view aprende os nomes novos (1) e só então os dados mudam (2).
-- Mesmo defeito de 20260803_casos_whitelist_etiquetas_novas,
-- 20260826_casos_whitelist_orto_suspensa e 20260827_casos_whitelist_acordo_enviado.
--
-- "7. Reajuizar" continua na lista branca de propósito, mesmo sem nenhuma linha usando
-- depois desta migração: é guarda barata contra qualquer gravação com o vocabulário
-- antigo (import, n8n, aba salva no navegador de alguém) — o caso apareceria errado no
-- filtro, mas não sumiria do CRM.
--
-- `cobrancas_set_etapa()` NÃO precisa mudar: o ramo
-- `~* 'fazer a[çc][ãa]o|para protocolar|reajuizar|...'` já casa os dois nomes novos e
-- deriva etapa='fazer_acao' quando não há número de processo, que é o caso deles.
--
-- Idempotente. Aborta sem tocar em nada se a âncora esperada não estiver na viewdef.

-- (1) lista branca da view casos -------------------------------------------
DO $$
DECLARE def text; novo text;
BEGIN
  SELECT pg_get_viewdef('public.casos'::regclass, true) INTO def;
  def := regexp_replace(def, ';\s*$', '');
  IF position('''Reajuizar''::text' in def) = 0 THEN
    novo := replace(
      def,
      '''Acordo enviado''::text]',
      '''Acordo enviado''::text, ''Reajuizar''::text, ''Reajuizar - Cessão''::text]'
    );
    IF novo = def THEN
      RAISE EXCEPTION 'ancora ''Acordo enviado'' nao encontrada na viewdef — abortando sem alterar a view';
    END IF;
    EXECUTE 'CREATE OR REPLACE VIEW public.casos WITH (security_invoker = true) AS ' || novo;
  END IF;
END $$;

-- (2) renomeia as cobranças que usam o nome antigo --------------------------
-- Só depois de (1). Roda na mesma transação da migração, então não existe janela
-- em que o status já mudou e a view ainda não conhece o nome.
UPDATE public.cobrancas
   SET status = 'Reajuizar', updated_at = now()
 WHERE status = '7. Reajuizar';

-- (3) prova ------------------------------------------------------------------
-- Conferir depois de aplicar: o total tem de bater com o que havia em "7. Reajuizar"
-- (16 ativas em 27/08/2026) e nenhuma pode ter sumido da view. A view `casos` não expõe
-- coluna de status, então a contagem do CRM se faz pelo id.
--   select status, count(*) from public.cobrancas where status ilike '%reajuiz%' group by 1;
--   select count(*) from public.cobrancas cb
--    where cb.status = 'Reajuizar' and exists (select 1 from public.casos k where k.id = cb.id);
-- As duas contagens têm de dar 16. Se a segunda vier menor, a lista branca não pegou.
