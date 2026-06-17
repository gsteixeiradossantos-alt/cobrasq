-- 20260617_05_undraft_outros_casos_reais.sql
-- ----------------------------------------------------------------------------
-- PENDENTE: aplicar SOMENTE após confirmação do gestor.
--
-- Mesma causa/raiz do 20260617_04_undraft_gisele.sql. A auditoria da divergência
-- blob×relacional (isDraft=true no blob, is_draft=false no relacional) achou,
-- além da Gisele, mais 3 casos com sinais de caso REAL (valor/credor/eventos)
-- que também foram rebaixados a rascunho pelo auto-save e sumiram da lista:
--     e939bed1-… GENIR FAVERO GALVAN  (R$3.000, "Em negociação"; 6 eventos)
--     bcafda84-… Sidiclei Zanotto     (R$530, com credor; 1 evento migrado)
--     141b6dbd-… Wesley de Lima       (R$554, com credor; 0 eventos — limítrofe)
-- Os demais 8 elementos isDraft=true do blob são rascunhos genuínos (só nome/doc,
-- sem valor/credor/eventos) e NÃO entram aqui.
--
-- AÇÃO: para cada id, remove draftExpiresAt/autoSavedAt e seta isDraft=false.
--   Preserva a ordem do array. Relacional já está is_draft=false -> não tocado.
-- F-01: avisar quem estiver com o app aberto para dar REFRESH após aplicar.
--
-- Rollback: 20260617_05_undraft_outros_casos_reais_rollback.sql
-- ----------------------------------------------------------------------------

BEGIN;

UPDATE public.cobrasq_data
SET data = jsonb_set(
  data,
  '{devedores}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN e.val->>'id' IN (
          'e939bed1-33b3-4999-adcf-926420e5b048', -- GENIR FAVERO GALVAN
          'bcafda84-ff5c-49fc-89a3-c22c6baa6070', -- Sidiclei Zanotto
          '141b6dbd-5da6-48e7-83aa-e4e1225d7bb4'  -- Wesley de Lima (R$554)
        )
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
