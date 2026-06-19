-- ============================================================================
-- TEMPO-2 / FASE C2 — DROP das colunas de dívida (depreciadas) de `devedores`.
-- ⚠️⚠️  NÃO RODAR AINDA. Esta é a ETAPA FINAL, e tem PRÉ-REQUISITOS. ⚠️⚠️
-- ----------------------------------------------------------------------------
-- Aplicar SOMENTE depois de TUDO abaixo:
--
--  1) Este PR (tempo-2) EM PRODUÇÃO e em burn-in:
--       • cliente: devedorToRow NÃO grava mais dívida; leitores leem via
--         _mergeDividaFromCobrancas (fonte = cobrancas).
--       • server: api/_processar-recebimento.js lê valor_orig de cobrancas;
--         api/cron-regua.js lê o blob (não a tabela) → ok.
--
--  2) PATCH OBRIGATÓRIO do trigger `fn_casos_insert` (caminho de criação de caso
--     do CRM via view `casos`): hoje ele faz
--         INSERT INTO public.devedores (... status, fase ...) VALUES (... v_status, v_fase ...)
--     Dropar status/fase ANTES de tirar essas colunas do INSERT do trigger
--     QUEBRA a criação de casos pelo CRM. Procedimento seguro:
--       a) Capturar a definição VIGENTE ao vivo (pode ter mudado desde 2026-06-15b):
--            SELECT pg_get_functiondef('public.fn_casos_insert'::regprocedure);
--       b) Re-declarar removendo `status, fase` (e `v_status, v_fase`) APENAS do
--            INSERT em `public.devedores` — manter o INSERT em `public.cobrancas`
--            (lá status/fase continuam, é a fonte única).
--       c) Conferir fn_casos_update (hoje NÃO escreve status/fase em devedores → ok).
--
--  3) Verificação final (devem retornar 0):
--       • grep no código/edge functions/RPCs por leitura/escrita destas colunas.
--       • a view `casos` NÃO referencia estas colunas de `d` (devedores) → ok,
--         mas reconfirme com pg_get_viewdef antes de dropar.
--
-- Reversível: o rollback recria as colunas (vazias); o dado vive em `cobrancas`.
-- ============================================================================

-- >>> Só descomente após cumprir os pré-requisitos 1–3 acima. <<<
/*
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
*/
