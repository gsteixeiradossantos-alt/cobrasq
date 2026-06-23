-- TEMPO-2 (Passo 5) — DROP das 16 colunas de dívida DEPRECIADAS de `devedores`.
-- *** IRREVERSÍVEL *** — aplicar SÓ após todos os pré-requisitos (todos verificados):
--   • `devedorToRow` não grava dívida (FASE C);
--   • crm.html (acordo_final → cobrancas) e import Astrea (sem status/fase) — PR #124 — DEPLOYADOS;
--   • trigger `fn_casos_insert` recriado sem status/fase no INSERT de devedores (aplicado 2026-06-23);
--   • nenhuma VIEW depende dessas colunas (verificado via pg_depend → vazio);
--   • leitores client leem via shim `_mergeDividaFromCobrancas` (de cobrancas) — intactos;
--   • servidor: cron-regua lê do blob `cobrasq_data`; edge functions leem da view `casos` — drop-safe;
--   • SNAPSHOT/backup do banco feito.
-- A dívida vive em `cobrancas` (fonte única). `responsavel_id` (legado, NÃO-dívida) fica fora.

ALTER TABLE public.devedores
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS fase,
  DROP COLUMN IF EXISTS valor_orig,
  DROP COLUMN IF EXISTS valor_atual,
  DROP COLUMN IF EXISTS data_entrada,
  DROP COLUMN IF EXISTS divida,
  DROP COLUMN IF EXISTS tipo_cobranca,
  DROP COLUMN IF EXISTS passo_atual,
  DROP COLUMN IF EXISTS aguardando_resposta,
  DROP COLUMN IF EXISTS encerramento,
  DROP COLUMN IF EXISTS acordo_final,
  DROP COLUMN IF EXISTS encaminhamento_judicial,
  DROP COLUMN IF EXISTS etapa_atualizada_em,
  DROP COLUMN IF EXISTS objecao_adicionais,
  DROP COLUMN IF EXISTS mesa_gestor,
  DROP COLUMN IF EXISTS checklist_judicial;
