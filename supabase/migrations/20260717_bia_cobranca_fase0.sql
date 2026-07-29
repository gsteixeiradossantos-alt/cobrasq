-- JÁ APLICADO EM PROD (versão 20260717194536). Snapshot reconstruído do catálogo em 2026-07-29. NÃO rodar db push.
-- ============================================================================
-- Bia Cobrança · Fase 0: espelho local das cobranças do Asaas que a Bia
-- acompanha (sync via worker), + chaves de config do modo cobrança na
-- singleton whatsapp_bia_config.
--
-- Colunas data_prometida e motivo_adiamento NÃO entram aqui — chegaram nas
-- migrações 20260717223107 (fase 2) e 20260717233839 (negociacao_motivo).
-- Grants de tabela são os defaults do schema public (anon/authenticated/
-- service_role com ALL); a trava real é a RLS owner-only abaixo.
-- ============================================================================

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
  lembretes_enviados  integer NOT NULL DEFAULT 0,
  ultimo_lembrete_em  timestamptz,
  proximo_lembrete_em timestamptz,
  adiamentos          integer NOT NULL DEFAULT 0,
  promessas_quebradas integer NOT NULL DEFAULT 0,
  primeiro_contato_em timestamptz,
  marcada_acao_em     timestamptz,
  observacao          text,
  synced_em           timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bia_cobranca_status ON public.bia_cobranca USING btree (status);
CREATE INDEX IF NOT EXISTS idx_bia_cobranca_tel    ON public.bia_cobranca USING btree (telefone);

ALTER TABLE public.bia_cobranca ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bia_cobranca_owner_all ON public.bia_cobranca;
CREATE POLICY bia_cobranca_owner_all ON public.bia_cobranca
  FOR ALL
  USING (current_user_papel() = 'proprietario')
  WITH CHECK (current_user_papel() = 'proprietario');

-- Config do modo cobrança (singleton whatsapp_bia_config).
-- TODO conferir: atribuição destas 3 colunas à fase 0 é inferida pela ordem
-- física das colunas no catálogo (depois de modo_boleto_only, 14:27 do mesmo
-- dia) e pela semântica; pode ter vindo de uma das fases seguintes.
ALTER TABLE public.whatsapp_bia_config
  ADD COLUMN IF NOT EXISTS cobranca_ativa          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cobranca_teste_telefone text,
  ADD COLUMN IF NOT EXISTS cobranca_dia_max        integer NOT NULL DEFAULT 15;
