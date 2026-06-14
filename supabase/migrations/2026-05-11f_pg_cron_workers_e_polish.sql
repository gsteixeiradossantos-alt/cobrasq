-- Etapa 6: pg_cron + pg_net + agendamento + polimentos
-- Aplicada em produção via MCP em 2026-05-11.
--
-- ATENÇÃO: o agendamento de cron-msg-agendadas só é criado se o segredo
-- CRON_INVOKE_SECRET estiver no Vault. Pra ativar:
--   1. SELECT vault.create_secret('<random-32-char>', 'CRON_INVOKE_SECRET');
--   2. supabase secrets set CRON_INVOKE_SECRET=<o-mesmo-random-32-char>
--   3. Re-executar o bloco DO $$ ... $$ desta migration (linhas 32+).

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Índices que faltam
CREATE INDEX IF NOT EXISTS idx_msgs_status_agendada ON public.crm_mensagens_agendadas(status, agendada_para);
CREATE INDEX IF NOT EXISTS idx_falhas_status_retry  ON public.crm_envios_falhados(status, retry_at);
CREATE INDEX IF NOT EXISTS idx_devedores_assigned   ON public.devedores(assigned_to);
CREATE INDEX IF NOT EXISTS idx_devedor_eventos_devedor_criado ON public.devedor_eventos(devedor_id, criado_em DESC);

-- DELETE/UPDATE policies que faltam
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='crm_mensagens_agendadas' AND policyname='msg_agendada_delete_owner') THEN
    CREATE POLICY msg_agendada_delete_owner ON public.crm_mensagens_agendadas
      FOR DELETE USING (operador_id = auth.uid() OR current_user_papel() = 'proprietario');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='crm_envios_falhados' AND policyname='envios_falhados_update') THEN
    CREATE POLICY envios_falhados_update ON public.crm_envios_falhados
      FOR UPDATE USING (auth.uid() IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='crm_envios_falhados' AND policyname='envios_falhados_delete') THEN
    CREATE POLICY envios_falhados_delete ON public.crm_envios_falhados
      FOR DELETE USING (operador_id = auth.uid() OR current_user_papel() = 'proprietario');
  END IF;
END $$;

-- Schedule do cron-mensagens-agendadas (1 min) — só se o segredo já estiver no Vault
DO $$
DECLARE
  v_url text := 'https://jokbxzhcctcwnbhkhgru.functions.supabase.co/cron-mensagens-agendadas';
  v_secret text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'CRON_INVOKE_SECRET' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN v_secret := NULL;
  END;

  IF v_secret IS NULL THEN
    RAISE NOTICE 'CRON_INVOKE_SECRET não está no Vault. Pra ativar: vault.create_secret(...) e re-rodar este DO.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('cron-msg-agendadas') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='cron-msg-agendadas');

  PERFORM cron.schedule(
    'cron-msg-agendadas',
    '* * * * *',
    format($cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', 'Bearer ' || %L, 'Content-Type', 'application/json'),
        body := '{}'::jsonb,
        timeout_milliseconds := 25000
      );
    $cmd$, v_url, v_secret)
  );
END $$;
