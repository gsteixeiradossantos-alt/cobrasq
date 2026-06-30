-- ============================================================
-- Bia agente de atendimento automático de WhatsApp
-- ============================================================
-- 3 tabelas: config (liga/desliga + grupo), estado do atendimento por telefone,
-- e log/auditoria com trava anti-duplo-envio. O worker (Edge Function
-- bia-atendimento), disparado por pg_cron, lê estas tabelas via service role.
--
-- Princípio anti-loop: a Bia só age sobre conversa cuja ÚLTIMA mensagem é do
-- cliente (vw_conversas_pendentes), responde cada message_id 1x (UNIQUE no log),
-- e encerra por DECISÃO (resolvido/handoff). turno_max_seguranca é só rede.

-- ------------------------------------------------------------
-- Config (singleton: 1 linha). Começa DESLIGADO.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_bia_config (
  id                  int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  auto_ativo          boolean NOT NULL DEFAULT false,
  grupo_empresa_tel   text,                       -- telefone/ID do grupo p/ avisos
  cooldown_seg        int NOT NULL DEFAULT 30,    -- intervalo mínimo entre auto-respostas ao mesmo nº
  turno_max_seguranca int NOT NULL DEFAULT 12,    -- backstop: força handoff após N turnos
  updated_by          uuid REFERENCES auth.users(id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.whatsapp_bia_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.whatsapp_bia_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bia_config_select_staff ON public.whatsapp_bia_config;
CREATE POLICY bia_config_select_staff ON public.whatsapp_bia_config
  FOR SELECT USING (current_user_papel() = ANY(ARRAY['proprietario','colaborador']));
DROP POLICY IF EXISTS bia_config_write_owner ON public.whatsapp_bia_config;
CREATE POLICY bia_config_write_owner ON public.whatsapp_bia_config
  FOR ALL USING (current_user_papel() = 'proprietario')
          WITH CHECK (current_user_papel() = 'proprietario');

COMMENT ON TABLE public.whatsapp_bia_config IS 'Config do agente Bia (auto-resposta WhatsApp). Singleton id=1. Lida pelo worker bia-atendimento.';

-- ------------------------------------------------------------
-- Estado do atendimento por telefone (a "memória" do agente).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_atendimentos (
  telefone           text PRIMARY KEY,
  caso_id            uuid REFERENCES public.devedores(id) ON DELETE SET NULL,
  estado             text NOT NULL DEFAULT 'bot',   -- bot | aguardando_humano | resolvido
  intencao           text,
  dados_coletados    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {nome, cpf, motivo, ...}
  turnos             int NOT NULL DEFAULT 0,
  resumo             text,                          -- resumo p/ humano assumir
  motivo_handoff     text,
  ultima_resposta_em timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_atend_estado ON public.whatsapp_atendimentos(estado);

ALTER TABLE public.whatsapp_atendimentos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bia_atend_staff_all ON public.whatsapp_atendimentos;
CREATE POLICY bia_atend_staff_all ON public.whatsapp_atendimentos
  FOR ALL USING (current_user_papel() = ANY(ARRAY['proprietario','colaborador']))
          WITH CHECK (current_user_papel() = ANY(ARRAY['proprietario','colaborador']));

COMMENT ON TABLE public.whatsapp_atendimentos IS 'Estado do agente Bia por telefone (bot/aguardando_humano/resolvido + dados coletados na triagem).';

-- ------------------------------------------------------------
-- Log/auditoria + trava anti-duplo-envio (1 resposta por message_id recebido).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_bia_log (
  id                  bigserial PRIMARY KEY,
  telefone            text NOT NULL,
  message_id_recebida text NOT NULL UNIQUE,   -- a msg do cliente que disparou (dedupe)
  resposta            text,
  acao                text,                    -- continuar | handoff | resolvido
  enviada_em          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_bia_log_tel ON public.whatsapp_bia_log(telefone, enviada_em DESC);

ALTER TABLE public.whatsapp_bia_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bia_log_select_staff ON public.whatsapp_bia_log;
CREATE POLICY bia_log_select_staff ON public.whatsapp_bia_log
  FOR SELECT USING (current_user_papel() = ANY(ARRAY['proprietario','colaborador']));
-- INSERT/UPDATE só via service role (worker), que bypassa RLS.

COMMENT ON TABLE public.whatsapp_bia_log IS 'Auditoria das auto-respostas da Bia. UNIQUE(message_id_recebida) garante 1 resposta por mensagem (anti-loop).';

-- ------------------------------------------------------------
-- Agenda o worker bia-atendimento a cada 1 min (só se o segredo já estiver no
-- Vault — CRON_INVOKE_SECRET já existe, usado pelo cron-mensagens-agendadas).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_url text := 'https://jokbxzhcctcwnbhkhgru.functions.supabase.co/bia-atendimento';
  v_secret text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'CRON_INVOKE_SECRET' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN v_secret := NULL;
  END;

  IF v_secret IS NULL THEN
    RAISE NOTICE 'CRON_INVOKE_SECRET não está no Vault; agendamento de bia-atendimento NÃO criado.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('bia-atendimento') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='bia-atendimento');

  PERFORM cron.schedule(
    'bia-atendimento',
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
