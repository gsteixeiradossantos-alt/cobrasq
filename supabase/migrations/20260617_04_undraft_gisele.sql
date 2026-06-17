-- 20260617_04_undraft_gisele.sql
-- ----------------------------------------------------------------------------
-- Incidente "Devedora Gisele sumiu" (2026-06-17) — recuperação do caso da Gisele.
--
-- SINTOMA: Gisele Silva dos Santos (acordo firmado, 7 boletos, 1 pago)
--   desapareceu da lista de Cobranças do painel.
-- CAUSA: o auto-save do modal de edição (S12) dispara a cada 30s
--   (mdevAutoSaveTick -> salvarDevedorRascunho({silencioso:true}), index.html
--   ~8551/8562) e marca isDraft:true INCONDICIONALMENTE (~8498), mesclando por
--   cima do registro existente (~8529). Em 12/06 alguém abriu o cadastro já
--   encerrado dela só para ver/editar; o timer rebaixou o caso a rascunho —
--   gravando apenas no BLOB cobrasq_data (o relacional ficou is_draft=false).
--   O app LÊ o blob e oculta rascunhos da lista (index.html ~7160,
--   "if(d.isDraft) return false") -> ela sumiu. Classe dual-write F-01.
-- RISCO: limparRascunhosVencidos() (index.html ~8606) apaga rascunhos vencidos
--   no load; draftExpiresAt = 2026-07-12 -> sem este fix o registro some de vez.
--
-- AÇÃO: no blob, no elemento data->'devedores' com id 197576db-…ca9fb1,
--   remove draftExpiresAt e autoSavedAt e seta isDraft=false. Preserva a ordem
--   do array (WITH ORDINALITY + ORDER BY ord). O relacional já está
--   is_draft=false -> NÃO é tocado.
--
-- IMPORTANTE (concorrência F-01): quem estiver com o app aberto deve dar
--   REFRESH após esta migração (um save() de sessão antiga reescreve o blob).
--
-- Os outros casos reais achados na auditoria (GENIR, Sidiclei, Wesley) estão em
--   20260617_05_undraft_outros_casos_reais.sql (aplicar após confirmação).
-- Rollback: 20260617_04_undraft_gisele_rollback.sql
-- ----------------------------------------------------------------------------

BEGIN;

UPDATE public.cobrasq_data
SET data = jsonb_set(
  data,
  '{devedores}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN e.val->>'id' = '197576db-eaaa-4af3-8143-0dc484ca9fb1'
        THEN (e.val - 'draftExpiresAt' - 'autoSavedAt')
               || jsonb_build_object('isDraft', false)
        ELSE e.val
      END
      ORDER BY e.ord
    )
    FROM jsonb_array_elements(data->'devedores') WITH ORDINALITY AS e(val, ord)
  )
),
updated_at = now()
WHERE key = 'main';

COMMIT;
