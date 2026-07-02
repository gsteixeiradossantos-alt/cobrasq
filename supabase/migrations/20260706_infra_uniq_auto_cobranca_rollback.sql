-- ============================================================
-- ROLLBACK de 20260706_infra_uniq_auto_cobranca.sql
-- ============================================================
-- Remove a trava anti-duplicidade da auto-cobrança. Seguro (só derruba o índice).

DROP INDEX IF EXISTS public.uq_crm_msg_agendadas_auto_cobranca;

-- --------------------------------------------------------------------------
-- (Referência) Limpeza de duplicatas, caso a CRIAÇÃO do índice falhe por já
-- existirem pares (caso_id, origem) repetidos. Mantém a linha mais antiga de
-- cada par e apaga as demais. Revisar/rodar MANUALMENTE só se necessário:
--
-- DELETE FROM public.crm_mensagens_agendadas a
-- USING public.crm_mensagens_agendadas b
-- WHERE a.origem LIKE 'auto_cobranca%'
--   AND b.origem = a.origem
--   AND b.caso_id IS NOT DISTINCT FROM a.caso_id
--   AND b.created_at < a.created_at;
