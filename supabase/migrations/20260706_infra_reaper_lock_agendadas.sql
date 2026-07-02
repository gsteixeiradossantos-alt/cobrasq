-- ============================================================
-- ✅ APLICADA EM PRODUÇÃO 2026-07-06 (via MCP, projeto jokbxzhcctcwnbhkhgru). Não reaplicar.
-- ============================================================
-- Reaper de lock preso em crm_mensagens_agendadas.
--
-- Problema: o cron-mensagens-agendadas usa um lock otimista marcando status='processando'
-- ao claimar cada linha. Se o processo morre no meio (timeout do runtime, deploy, crash),
-- a linha fica ETERNAMENTE 'processando' e nunca mais é enviada nem falha — fica presa.
--
-- Correção (2 partes):
--   (1) [ESTE ARQUIVO] adiciona a coluna `processando_desde timestamptz` que carimba
--       QUANDO o lock foi tomado.
--   (2) [FONTE da edge function cron-mensagens-agendadas] carimba `processando_desde=now()`
--       ao claimar e, no início de cada run, recicla p/ 'pendente' as linhas 'processando'
--       presas há mais de 10 min (ou sem carimbo — presas de antes desta migração).
--
-- Por que 10 min é seguro contra corrida legítima: o cron roda a cada 1 min e um run
-- processa o lote em segundos. Uma execução concorrente legítima jamais deixa uma linha
-- 'processando' por >10 min; só um processo MORTO deixa. Logo o reaper só recicla lock
-- morto, sem roubar item de run concorrente vivo.
--
-- APLICAR MANUALMENTE no SQL Editor do projeto jokbxzhcctcwnbhkhgru. Rollback em _rollback.sql.

ALTER TABLE public.crm_mensagens_agendadas
  ADD COLUMN IF NOT EXISTS processando_desde timestamptz;

COMMENT ON COLUMN public.crm_mensagens_agendadas.processando_desde IS
  'Carimbo de quando o lock (status=processando) foi tomado pelo cron. NULL fora de processamento. Usado pelo reaper que recicla locks presos >10 min.';

-- Índice parcial: acelera o SELECT do reaper (só linhas em processamento) sem pesar
-- nas linhas pendentes/enviadas (a grande maioria).
CREATE INDEX IF NOT EXISTS idx_crm_msg_agendadas_processando
  ON public.crm_mensagens_agendadas (processando_desde)
  WHERE status = 'processando';
