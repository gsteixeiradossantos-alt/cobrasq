-- JÁ APLICADO EM PROD (versão 20260612170301). Snapshot reconstruído do catálogo em 2026-07-29. NÃO rodar db push.
-- ============================================================================
-- F-20 (parte 2): proteção dos RESPONSÁVEIS no blob cobrasq_data.
--
-- ARQUIVO-STUB (sem DDL próprio): esta migração alterou a MESMA função
-- fn_cobrasq_data_anti_shrink criada pela 20260612021448, acrescentando o
-- segundo bloqueio — gravação que apagaria o campo 'responsavel' de mais de 3
-- devedores é rejeitada ("aba desatualizada: recarregue a página").
--
-- A definição ATUAL de prod (já com este bloqueio incorporado) está versionada
-- em: supabase/migrations/20260612_f20_trigger_anti_encolhimento_cobrasq_data.sql
-- (bloco v_resp_antes/v_resp_depois). Não existe função nem trigger separado
-- para responsáveis no catálogo — cobrasq_data tem UM único trigger:
-- trg_cobrasq_data_anti_shrink.
-- ============================================================================

select 1; -- no-op: conteúdo incorporado no arquivo irmão (ver cabeçalho)
