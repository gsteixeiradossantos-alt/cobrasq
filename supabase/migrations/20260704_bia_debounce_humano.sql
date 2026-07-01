-- ============================================================
-- Bia · convivência humano × robô: debounce de rajada + trava "humano atendendo"
-- ============================================================
-- Pré-requisito para LIGAR a Bia (auto_ativo=TRUE) com segurança. Três coisas:
--  1) debounce_seg: a Bia espera a RAJADA do cliente assentar antes de responder
--     (ver bia-atendimento: pula se a última recebida é mais nova que debounce_seg).
--  2) humano_ate: quando um HUMANO responde (painel OU celular), pausa a Bia por
--     humano_pausa_min minutos, expirando sozinha — resolve também o
--     'aguardando_humano' que hoje nunca limpa.
--  3) whatsapp_bia_enviadas: registro dos message_id enviados PELA Bia, pra o
--     webhook zapi-recebidas distinguir fromMe do robô (não seta humano_ate) do
--     fromMe humano (seta). Ver [[project_cobrasq_whatsapp_pendentes_redesign]].
-- Tudo aditivo; as edge functions toleram a ausência (behavior antigo) até rodar.

ALTER TABLE public.whatsapp_atendimentos
  ADD COLUMN IF NOT EXISTS humano_ate timestamptz;
COMMENT ON COLUMN public.whatsapp_atendimentos.humano_ate IS 'Enquanto now() < humano_ate, um humano está atendendo (painel/celular) e a Bia não responde. Expira sozinha.';

ALTER TABLE public.whatsapp_bia_config
  ADD COLUMN IF NOT EXISTS debounce_seg      int NOT NULL DEFAULT 120,  -- espera a rajada assentar (2 min)
  ADD COLUMN IF NOT EXISTS humano_pausa_min  int NOT NULL DEFAULT 30;   -- pausa da Bia após toque humano
COMMENT ON COLUMN public.whatsapp_bia_config.debounce_seg     IS 'A Bia só responde se a última mensagem recebida tem >= debounce_seg (espera a rajada terminar).';
COMMENT ON COLUMN public.whatsapp_bia_config.humano_pausa_min IS 'Minutos que a Bia fica pausada após um humano responder o número (painel ou celular).';

-- Registro dos envios DO ROBÔ (pra classificar fromMe no webhook). Escrita só via
-- service role (worker/webhook); RLS ligada, leitura liberada ao staff.
CREATE TABLE IF NOT EXISTS public.whatsapp_bia_enviadas (
  message_id text PRIMARY KEY,
  telefone   text,
  enviada_em timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.whatsapp_bia_enviadas IS 'message_id das mensagens enviadas pela Bia (bia-atendimento). O webhook zapi-recebidas usa pra não confundir o fromMe do robô com resposta humana.';

ALTER TABLE public.whatsapp_bia_enviadas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bia_enviadas_select_staff ON public.whatsapp_bia_enviadas;
CREATE POLICY bia_enviadas_select_staff ON public.whatsapp_bia_enviadas
  FOR SELECT USING (current_user_papel() = ANY(ARRAY['proprietario','colaborador']));
-- INSERT/UPDATE só via service role (worker/webhook), que bypassa RLS.

-- Higiene: purga registros antigos de envios da Bia (o webhook só olha os recentes).
CREATE INDEX IF NOT EXISTS idx_bia_enviadas_enviada_em ON public.whatsapp_bia_enviadas (enviada_em);
