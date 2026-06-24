-- ============================================================================
-- cobrancas.monitorar_datajud — liga/desliga monitoramento de andamentos por processo
-- ----------------------------------------------------------------------------
-- Contexto: o cron api/cron-datajud.js consulta o DataJud para TODA cobrança com
--   numero_processo preenchido. Esta flag dá controle por processo: o usuário pode
--   pausar o monitoramento de um caso específico mesmo com o número CNJ cadastrado.
--   Default TRUE → processos atuais e futuros já nascem monitorados (cadastrar o
--   número basta); o botão na UI serve para DESLIGAR. O cron passa a filtrar por
--   monitorar_datajud = true.
-- ----------------------------------------------------------------------------
-- Aditivo e reversível. Segue o padrão das flags booleanas de cobrancas
--   (arquivado, is_draft, aguardando_resposta — 2026-06-15a_cobrancas_e_partes.sql).
--   NÃO rodar `supabase db push` cego (ver CLAUDE.md): aplicar via Supabase MCP/SQL
--   Editor no projeto jokbxzhcctcwnbhkhgru após review. Rollback pareado:
--   2026-06-24a_cobrancas_monitorar_datajud_rollback.sql
-- ============================================================================

ALTER TABLE public.cobrancas
  ADD COLUMN IF NOT EXISTS monitorar_datajud BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.cobrancas.monitorar_datajud IS
  'Liga/desliga o monitoramento automático de andamentos (DataJud) deste processo. Default true; o cron-datajud só consulta cobranças com monitorar_datajud = true.';
