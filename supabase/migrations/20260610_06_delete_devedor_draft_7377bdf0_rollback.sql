-- 20260610_06_delete_devedor_draft_7377bdf0_rollback.sql
-- ----------------------------------------------------------------------------
-- ROLLBACK da exclusão do devedor-rascunho 7377bdf0 ("Janete Aparecida de
-- Oliveira"). Restaura EXATAMENTE o snapshot capturado em 2026-06-10 (read-only)
-- nos DOIS lugares: tabela relacional public.devedores E blob cobrasq_data.
--
-- Era um rascunho auto-salvo (metadata.isDraft=true), sem dívida/doc/telefone/
-- endereço/valor, sem eventos, sem dev_dividas, sem acordos. cadastrado_por =
-- Mikaelly (14e5ea2e-...). assigned_to = NULL.
-- ----------------------------------------------------------------------------

BEGIN;

-- (1) Restaurar a linha relacional (idempotente: não duplica se já existir)
INSERT INTO public.devedores
  (id, nome, cadastrado_por, assigned_to, status, fase, tipo_cobranca,
   is_draft, arquivado, aguardando_resposta, divida, metadata,
   created_at, updated_at, etapa_atualizada_em)
VALUES
  ('7377bdf0-4904-46aa-b7af-dc1e8fb142c8',
   'Janete Aparecida de Oliveira',
   '14e5ea2e-b106-43c8-bec1-235101b17f50',
   NULL,
   'Cobrar',
   'extrajudicial',
   'digital',
   false,
   false,
   false,
   '{}'::jsonb,
   '{"autoSavedAt":"2026-06-10T14:10:43.197Z","bairro":"","cep":"","cidade":"","complemento":"","draftExpiresAt":"2026-07-10T14:10:43.197Z","isDraft":true,"numero":"","obs":"","rua":"","tags":[],"titulo":"","uf":"","vencimento":""}'::jsonb,
   '2026-06-10T14:10:45.734139+00:00',
   '2026-06-10T14:10:45.734139+00:00',
   '2026-06-10T14:10:45.734139+00:00')
ON CONFLICT (id) DO NOTHING;

-- (2) Restaurar o elemento no blob cobrasq_data (só se ainda não estiver lá)
UPDATE public.cobrasq_data
SET data = jsonb_set(
  data,
  '{devedores}',
  (data->'devedores') || '{"id": "7377bdf0-4904-46aa-b7af-dc1e8fb142c8", "uf": "", "cep": "", "doc": "", "obs": "", "rua": "", "tel": "", "fase": "extrajudicial", "nome": "Janete Aparecida de Oliveira", "tags": [], "email": "", "bairro": "", "cidade": "", "divida": {}, "numero": "", "status": "Cobrar", "titulo": "", "acordos": [], "docHash": "", "entrada": "", "isDraft": true, "arquivado": false, "clienteId": "", "createdAt": "2026-06-10T14:10:45.734139+00:00", "historico": [], "updatedAt": "2026-06-10T14:10:45.734139+00:00", "valorOrig": "", "assignedTo": null, "passoAtual": null, "valorAtual": "", "vencimento": "", "acordoFinal": null, "autoSavedAt": "2026-06-10T14:10:43.197Z", "complemento": "", "encerramento": null, "tipoCobranca": "digital", "draftExpiresAt": "2026-07-10T14:10:43.197Z", "etapaAtualizadaEm": "2026-06-10T14:10:45.734139+00:00", "aguardandoResposta": false, "encaminhamentoJudicial": null}'::jsonb
)
WHERE key='main'
  AND NOT (data->'devedores') @> '[{"id":"7377bdf0-4904-46aa-b7af-dc1e8fb142c8"}]';

COMMIT;
