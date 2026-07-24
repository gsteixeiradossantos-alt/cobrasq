-- ============================================================
-- Bia · Cobrança ativa: tabelas de controle + colunas extras de config
-- ============================================================
-- Estas tabelas e colunas já existem em prod (criadas manualmente).
-- Esta migração serve apenas para DOCUMENTAR o schema no git.
-- Todas as operações são IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

-- ------------------------------------------------------------
-- whatsapp_bia_config: colunas extras de cobrança
-- ------------------------------------------------------------
ALTER TABLE public.whatsapp_bia_config
  ADD COLUMN IF NOT EXISTS teste_telefone         text,
  ADD COLUMN IF NOT EXISTS modo_boleto_only       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cobranca_ativa         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cobranca_teste_telefone text,
  ADD COLUMN IF NOT EXISTS cobranca_dia_max       int NOT NULL DEFAULT 15;

COMMENT ON COLUMN public.whatsapp_bia_config.teste_telefone         IS 'Se setado, bia-atendimento age SOMENTE neste telefone (modo teste).';
COMMENT ON COLUMN public.whatsapp_bia_config.modo_boleto_only       IS 'Se true, bia-atendimento responde somente números com registro em bia_cobranca (modo conservador).';
COMMENT ON COLUMN public.whatsapp_bia_config.cobranca_ativa         IS 'Se true, bia-cobranca envia lembretes de cobrança. Se false, só executa aprovações.';
COMMENT ON COLUMN public.whatsapp_bia_config.cobranca_teste_telefone IS 'Se setado, bia-cobranca age SOMENTE neste telefone (modo teste de cobrança ativa).';
COMMENT ON COLUMN public.whatsapp_bia_config.cobranca_dia_max       IS 'Dias após vencimento sem resposta para marcar como para_acao (encaminhar ao jurídico).';

-- ------------------------------------------------------------
-- bia_cobranca: espelho de cobranças ativas do Asaas
-- Populado por bia-cobranca-sync, consumido por bia-cobranca.
-- PK = asaas_payment_id (1 linha por boleto).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bia_cobranca (
  asaas_payment_id    text PRIMARY KEY,
  asaas_customer_id   text,
  telefone            text,
  nome                text,
  valor               numeric,
  venc_original       date,
  venc_atual          date,
  invoice_url         text,
  caso_id             uuid,
  status              text NOT NULL DEFAULT 'ativa',
  lembretes_enviados  int NOT NULL DEFAULT 0,
  ultimo_lembrete_em  timestamptz,
  proximo_lembrete_em timestamptz,
  adiamentos          int NOT NULL DEFAULT 0,
  promessas_quebradas int NOT NULL DEFAULT 0,
  primeiro_contato_em timestamptz,
  marcada_acao_em     timestamptz,
  observacao          text,
  synced_em           timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  data_prometida      date,
  motivo_adiamento    text
);

COMMENT ON TABLE public.bia_cobranca IS 'Espelho das cobranças vencidas/do-dia do Asaas. Populada por bia-cobranca-sync, consumida por bia-cobranca (worker de cobrança ativa).';

ALTER TABLE public.bia_cobranca ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bia_cobranca_staff ON public.bia_cobranca;
CREATE POLICY bia_cobranca_staff ON public.bia_cobranca
  FOR SELECT USING (current_user_papel() = ANY(ARRAY['proprietario','colaborador']));

-- ------------------------------------------------------------
-- bia_aprovacoes: fila de aprovação de alterações de vencimento
-- Criada por bia-atendimento (pedido do devedor), decidida no
-- painel ou via WhatsApp do gestor, aplicada por bia-cobranca.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bia_aprovacoes (
  id               bigserial PRIMARY KEY,
  tipo             text NOT NULL DEFAULT 'prazo_fora_do_mes',
  asaas_payment_id text,
  telefone         text,
  nome             text,
  data_pedida      date,
  status           text NOT NULL DEFAULT 'pendente',
  criado_em        timestamptz NOT NULL DEFAULT now(),
  decidido_em      timestamptz,
  decidido_por     text,
  resultado        text,
  motivo           text,
  sem_acrescimo    boolean NOT NULL DEFAULT false
);

COMMENT ON TABLE public.bia_aprovacoes IS 'Fila de aprovação de alterações de vencimento solicitadas pelo devedor via Bia. Decidida no painel/WhatsApp; aplicada pelo worker bia-cobranca.';

ALTER TABLE public.bia_aprovacoes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bia_aprovacoes_staff ON public.bia_aprovacoes;
CREATE POLICY bia_aprovacoes_staff ON public.bia_aprovacoes
  FOR ALL USING (current_user_papel() = ANY(ARRAY['proprietario','colaborador']))
          WITH CHECK (current_user_papel() = ANY(ARRAY['proprietario','colaborador']));

-- ------------------------------------------------------------
-- bia_cobranca_log: auditoria dos lembretes enviados
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bia_cobranca_log (
  id               bigserial PRIMARY KEY,
  asaas_payment_id text,
  telefone         text,
  lembrete_num     int,
  texto            text,
  enviada_em       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.bia_cobranca_log IS 'Log/auditoria dos lembretes de cobrança enviados pelo worker bia-cobranca.';

ALTER TABLE public.bia_cobranca_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bia_cobranca_log_staff ON public.bia_cobranca_log;
CREATE POLICY bia_cobranca_log_staff ON public.bia_cobranca_log
  FOR SELECT USING (current_user_papel() = ANY(ARRAY['proprietario','colaborador']));

-- ------------------------------------------------------------
-- Crons para bia-cobranca e bia-cobranca-sync
-- ------------------------------------------------------------
DO $$
DECLARE
  v_base text := 'https://jokbxzhcctcwnbhkhgru.functions.supabase.co';
  v_secret text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'CRON_INVOKE_SECRET' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN v_secret := NULL;
  END;

  IF v_secret IS NULL THEN
    RAISE NOTICE 'CRON_INVOKE_SECRET não está no Vault; crons de bia-cobranca NÃO criados.';
    RETURN;
  END IF;

  -- bia-cobranca: a cada 5 minutos
  PERFORM cron.unschedule('bia-cobranca') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='bia-cobranca');
  PERFORM cron.schedule(
    'bia-cobranca',
    '*/5 * * * *',
    format($cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', 'Bearer ' || %L, 'Content-Type', 'application/json'),
        body := '{}'::jsonb,
        timeout_milliseconds := 25000
      );
    $cmd$, v_base || '/bia-cobranca', v_secret)
  );

  -- bia-cobranca-sync: a cada 30 min (sincroniza boletos vencidos/do dia)
  PERFORM cron.unschedule('bia-cobranca-sync') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='bia-cobranca-sync');
  PERFORM cron.schedule(
    'bia-cobranca-sync',
    '*/30 * * * *',
    format($cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', 'Bearer ' || %L, 'Content-Type', 'application/json'),
        body := '{}'::jsonb,
        timeout_milliseconds := 25000
      );
    $cmd$, v_base || '/bia-cobranca-sync', v_secret)
  );
END $$;
