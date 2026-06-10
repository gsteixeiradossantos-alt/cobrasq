-- 20260610_06_delete_devedor_draft_7377bdf0.sql
-- ----------------------------------------------------------------------------
-- Exclusão APROVADA pelo gestor (2026-06-10) do devedor-rascunho 7377bdf0
-- ("Janete Aparecida de Oliveira"): rascunho auto-salvo, sem dívida/doc/
-- telefone/endereço/valor, SEM devedor_eventos, SEM dev_dividas, SEM acordos
-- (blast radius verificado = 0 dependências).
--
-- Remove dos DOIS lugares (senão o dual-write do app recria — F-01/F-08):
--   (1) tabela relacional public.devedores
--   (2) elemento do array data->'devedores' no blob cobrasq_data (key='main')
--
-- Rollback: 20260610_06_delete_devedor_draft_7377bdf0_rollback.sql (restaura
-- a linha e o elemento do blob a partir do snapshot read-only).
--
-- AVISO DE CONCORRÊNCIA (F-01): se a sessão da Mikaelly estiver aberta com esse
-- rascunho em memória, um save dela pode recriá-lo. Exclusão definitiva =
-- ela/gestor exclui pelo app, ou após ela sair. Esta remoção é best-effort.
-- ----------------------------------------------------------------------------

BEGIN;

-- (1) Remover do blob (single-statement, atômico; remove o elemento do array)
UPDATE public.cobrasq_data
SET data = jsonb_set(
  data,
  '{devedores}',
  COALESCE(
    (SELECT jsonb_agg(e)
       FROM jsonb_array_elements(data->'devedores') e
      WHERE e->>'id' <> '7377bdf0-4904-46aa-b7af-dc1e8fb142c8'),
    '[]'::jsonb
  )
)
WHERE key='main';

-- (2) Remover da tabela relacional (sem dependências -> sem cascade)
DELETE FROM public.devedores
WHERE id='7377bdf0-4904-46aa-b7af-dc1e8fb142c8';

COMMIT;
