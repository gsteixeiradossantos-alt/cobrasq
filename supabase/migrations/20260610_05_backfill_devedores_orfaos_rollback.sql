-- 20260610_05_backfill_devedores_orfaos_rollback.sql
-- ----------------------------------------------------------------------------
-- ROLLBACK do backfill 20260610_05. Restaura EXATAMENTE os valores anteriores
-- capturados do prod em 2026-06-10 (read-only) ANTES da escrita.
--
-- Snapshot original (id -> assigned_to | cadastrado_por):
--   todos os 21 tinham assigned_to = NULL.
--   cadastrado_por: 16 eram NULL; 5 já tinham criador (preservados, então
--   este rollback NÃO precisa tocá-los — só desfaz o que o backfill escreveu).
-- ----------------------------------------------------------------------------

BEGIN;

-- (1) Reverter assigned_to -> NULL nos 21 ids (só se ainda apontar p/ gestor)
UPDATE public.devedores
SET assigned_to = NULL
WHERE id IN (
  '197576db-eaaa-4af3-8143-0dc484ca9fb1',
  '1fa366c9-4d97-462d-be78-71461f25cac5',
  '208de69a-5ccf-4ab3-83d8-691b70be7074',
  '2d66a7ea-3e07-4f05-9ea5-30e5466bf1c8',
  '38f5ada7-ff81-4698-8c29-48bb71a90b76',
  '445d1459-71bd-4d6c-80a9-a98412a0b0b8',
  '69609ec5-7b9f-424d-b949-ccf365fedaa2',
  '7020ab98-c0d4-416c-87d1-0372e196d6e3',
  '733999f6-5438-4ba8-a0d9-423c60574490',
  '7377bdf0-4904-46aa-b7af-dc1e8fb142c8',
  '814e1a7b-6e9d-4252-9bfe-346802250a7b',
  '83f6476f-c4e3-4821-ab08-dd9dbc6db796',
  '9773025d-f681-4560-a9f5-52f8e5da4567',
  'a387b2e3-ba8c-4ee3-831c-f50ac885342e',
  'a85b90e0-96df-4f9e-a850-bc55b7c38c5e',
  'ba33ef26-fe6d-4943-8a75-a48aee2f4f43',
  'ba8218ed-c477-4247-9bac-4ba2b94640e3',
  'e1a4c3ab-ed00-4f12-b295-d2357b25121e',
  'e7026d70-4e6d-439c-bb74-3d210261afb1',
  'f833cd02-5902-4690-8400-46a03457ea1a',
  'fcb5d321-662c-465d-a0ed-3e5d9cf8c89b'
)
AND assigned_to = '4fc57db2-4ecf-4021-81f3-c30004e708b8';

-- (2) Reverter cadastrado_por -> NULL SOMENTE nas 16 que o backfill preencheu.
--     (as 5 com criador real nunca foram tocadas, então não constam aqui)
UPDATE public.devedores
SET cadastrado_por = NULL
WHERE id IN (
  '197576db-eaaa-4af3-8143-0dc484ca9fb1',
  '2d66a7ea-3e07-4f05-9ea5-30e5466bf1c8',
  '38f5ada7-ff81-4698-8c29-48bb71a90b76',
  '445d1459-71bd-4d6c-80a9-a98412a0b0b8',
  '69609ec5-7b9f-424d-b949-ccf365fedaa2',
  '7020ab98-c0d4-416c-87d1-0372e196d6e3',
  '814e1a7b-6e9d-4252-9bfe-346802250a7b',
  '83f6476f-c4e3-4821-ab08-dd9dbc6db796',
  '9773025d-f681-4560-a9f5-52f8e5da4567',
  'a387b2e3-ba8c-4ee3-831c-f50ac885342e',
  'a85b90e0-96df-4f9e-a850-bc55b7c38c5e',
  'ba33ef26-fe6d-4943-8a75-a48aee2f4f43',
  'e1a4c3ab-ed00-4f12-b295-d2357b25121e',
  'e7026d70-4e6d-439c-bb74-3d210261afb1',
  'f833cd02-5902-4690-8400-46a03457ea1a',
  'fcb5d321-662c-465d-a0ed-3e5d9cf8c89b'
)
AND cadastrado_por = '4fc57db2-4ecf-4021-81f3-c30004e708b8';

COMMIT;
