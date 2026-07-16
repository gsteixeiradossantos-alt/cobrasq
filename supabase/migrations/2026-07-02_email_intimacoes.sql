-- ============================================================
-- Varredura de e-mails de tribunais → intimações/movimentações
-- ============================================================
-- A Edge Function `email-intimacoes` (disparada por pg_cron) lê a caixa de
-- e-mails do escritório via IMAP, manda cada e-mail para o Claude extrair os
-- atos (funciona com qualquer formato: eproc, PROJUDI, peticionamento) e grava
-- aqui. Cada ATO extraído vira uma linha em `intimacoes_email`.
--
-- Casamento (decisão do escritório): quando o número do processo do e-mail bate
-- com uma cobrança cadastrada (cobrancas.numero_processo), o ato é VINCULADO e
-- também gravado em devedor_eventos (timeline unificada, fonte='email') +
-- proc_intimacoes (alertas). Quando NÃO bate, fica status 'a_vincular' na fila,
-- para o gestor vincular/cadastrar num clique. Nada se perde.
--
-- `email_msgs_processadas` evita reprocessar (e re-chamar a IA) o mesmo e-mail.

-- ------------------------------------------------------------
-- Caixa de intimações extraídas dos e-mails.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.intimacoes_email (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_uid       text,                       -- UID IMAP da mensagem de origem
  email_msg_id    text,                       -- Message-ID (RFC822) da mensagem
  recebido_em     timestamptz,                -- data do e-mail
  remetente       text,
  assunto         text,
  numero_processo text,                        -- CNJ formatado (nullable se não achou)
  digitos         text,                        -- 20 dígitos do CNJ (p/ casar)
  tribunal        text,                        -- TJPR/TJSC/TJRS… (derivado do número)
  sistema         text,                        -- eproc | projudi | peticionamento | outro
  tipo            text,                        -- movimentacao | peticionamento | intimacao
  ato             text,                        -- texto cru do ato (como veio no e-mail)
  ato_curado      text,                        -- rótulo amigável (para a timeline)
  evento_numero   text,
  data_ato        date,                        -- data do ato (ou do e-mail)
  exequente       text,
  executado       text,
  partes          jsonb,
  confianca       numeric,                     -- 0..1 (confiança da extração)
  status          text NOT NULL DEFAULT 'a_vincular'
                    CHECK (status IN ('a_vincular','vinculada','ignorada')),
  cobranca_id     uuid REFERENCES public.cobrancas(id) ON DELETE SET NULL,
  devedor_id      uuid,
  dedup           text UNIQUE,                 -- idempotência (1 ato = 1 linha)
  raw             jsonb,                       -- saída bruta da IA + trecho do e-mail
  criado_em       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_intim_email_status  ON public.intimacoes_email(status, recebido_em DESC);
CREATE INDEX IF NOT EXISTS idx_intim_email_proc    ON public.intimacoes_email(digitos);
CREATE INDEX IF NOT EXISTS idx_intim_email_cobr    ON public.intimacoes_email(cobranca_id);

ALTER TABLE public.intimacoes_email ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intim_email_staff_select ON public.intimacoes_email;
CREATE POLICY intim_email_staff_select ON public.intimacoes_email
  FOR SELECT USING (current_user_papel() = ANY(ARRAY['proprietario','colaborador']));
DROP POLICY IF EXISTS intim_email_owner_write ON public.intimacoes_email;
CREATE POLICY intim_email_owner_write ON public.intimacoes_email
  FOR ALL USING (current_user_papel() = 'proprietario')
          WITH CHECK (current_user_papel() = 'proprietario');
-- INSERT/UPDATE em massa vêm do worker (service role, bypassa RLS).

COMMENT ON TABLE public.intimacoes_email IS 'Intimações/movimentações extraídas por IA dos e-mails de tribunais. status a_vincular=fila; vinculada=casou com cobrança (também em devedor_eventos); ignorada=ruído. Escrita pelo worker email-intimacoes.';

-- ------------------------------------------------------------
-- Controle de e-mails já processados (não re-chamar a IA no mesmo e-mail).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_msgs_processadas (
  uid            text PRIMARY KEY,             -- UID IMAP (ou Message-ID)
  assunto        text,
  remetente      text,
  recebido_em    timestamptz,
  atos_extraidos int NOT NULL DEFAULT 0,
  processado_em  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.email_msgs_processadas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_msgs_staff_select ON public.email_msgs_processadas;
CREATE POLICY email_msgs_staff_select ON public.email_msgs_processadas
  FOR SELECT USING (current_user_papel() = ANY(ARRAY['proprietario','colaborador']));

COMMENT ON TABLE public.email_msgs_processadas IS 'UIDs de e-mails já lidos pelo worker email-intimacoes (idempotência / evita recustar IA).';

-- Idempotência dos andamentos de e-mail em devedor_eventos (espelha o índice
-- do datajud da migração 2026-06-30_01). Evita duplicar um ato já lançado.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dev_eventos_email_dedup
  ON public.devedor_eventos ((payload->>'dedup'))
  WHERE tipo = 'andamento_judicial' AND payload->>'fonte' = 'email';

-- ------------------------------------------------------------
-- Fila "Intimações a vincular" (para a tela do gestor).
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_intimacoes_a_vincular
  WITH (security_invoker = true) AS
SELECT id, recebido_em, numero_processo, digitos, tribunal, sistema, tipo,
       ato, ato_curado, evento_numero, data_ato, exequente, executado, confianca, criado_em
FROM public.intimacoes_email
WHERE status = 'a_vincular'
ORDER BY recebido_em DESC NULLS LAST;

-- ------------------------------------------------------------
-- Agenda o worker email-intimacoes a cada 30 min (só se CRON_INVOKE_SECRET já
-- estiver no Vault). O worker também precisa dos secrets GMAIL_USER /
-- GMAIL_APP_PASSWORD / ANTHROPIC_API_KEY (setados no painel) para funcionar.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_url text := 'https://jokbxzhcctcwnbhkhgru.functions.supabase.co/email-intimacoes';
  v_secret text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'CRON_INVOKE_SECRET' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN v_secret := NULL;
  END;

  IF v_secret IS NULL THEN
    RAISE NOTICE 'CRON_INVOKE_SECRET não está no Vault; agendamento de email-intimacoes NÃO criado.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('email-intimacoes') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='email-intimacoes');

  PERFORM cron.schedule(
    'email-intimacoes',
    '*/30 * * * *',
    format($cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', 'Bearer ' || %L, 'Content-Type', 'application/json'),
        body := '{}'::jsonb,
        timeout_milliseconds := 55000
      );
    $cmd$, v_url, v_secret)
  );
END $$;
