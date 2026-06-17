-- 20260617_04_undraft_gisele_rollback.sql
-- ----------------------------------------------------------------------------
-- Reverte 20260617_04_undraft_gisele.sql: recoloca a Gisele como rascunho no
-- blob com os valores originais (snapshot pré-aplicação 2026-06-17).
-- Preserva a ordem do array. Não toca no relacional.
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
        THEN e.val || jsonb_build_object(
               'isDraft', true,
               'draftExpiresAt', '2026-07-12T07:47:54.589Z',
               'autoSavedAt', '2026-06-12T07:47:54.590Z')
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
