-- 20260617_05_undraft_outros_casos_reais_rollback.sql
-- ----------------------------------------------------------------------------
-- Reverte 20260617_05_undraft_outros_casos_reais.sql: recoloca GENIR, Sidiclei
-- e Wesley como rascunho no blob com os valores originais (snapshot pré-aplicação
-- 2026-06-17). Sidiclei e Wesley não tinham autoSavedAt -> não é re-adicionado.
-- Preserva a ordem do array. Não toca no relacional.
-- ----------------------------------------------------------------------------

BEGIN;

UPDATE public.cobrasq_data
SET data = jsonb_set(
  data,
  '{devedores}',
  (
    SELECT jsonb_agg(
      CASE e.val->>'id'
        WHEN 'e939bed1-33b3-4999-adcf-926420e5b048' THEN e.val || jsonb_build_object(
          'isDraft', true,
          'draftExpiresAt', '2026-07-11T14:52:23.773Z',
          'autoSavedAt', '2026-06-11T14:52:23.773Z')
        WHEN 'bcafda84-ff5c-49fc-89a3-c22c6baa6070' THEN e.val || jsonb_build_object(
          'isDraft', true,
          'draftExpiresAt', '2026-07-12T17:49:51.207Z')
        WHEN '141b6dbd-5da6-48e7-83aa-e4e1225d7bb4' THEN e.val || jsonb_build_object(
          'isDraft', true,
          'draftExpiresAt', '2026-07-11T13:19:30.652Z')
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
