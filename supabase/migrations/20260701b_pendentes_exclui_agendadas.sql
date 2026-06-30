-- ============================================================
-- Ajuste da fila de pendentes: tira da fila quem já tem RESPOSTA AGENDADA.
-- ============================================================
-- A view 20260701 só considerava "respondida" um outbound já enviado
-- (crm_mensagens_status). Mas resposta agendada fora do horário só vira
-- outbound de manhã, então a conversa reaparecia na fila no meio-tempo
-- (risco de retrabalho). Aqui também excluímos quando existe um agendamento
-- pra aquele telefone criado DEPOIS da mensagem recebida.
--
-- Mesmas colunas (r.*) -> CREATE OR REPLACE VIEW serve. security_invoker
-- continua valendo (herda RLS de recebidas/status/agendadas).

CREATE OR REPLACE VIEW public.vw_conversas_pendentes
WITH (security_invoker = true) AS
SELECT r.*
FROM public.crm_mensagens_recebidas r
WHERE r.recebida_em = (
  SELECT max(r2.recebida_em)
  FROM public.crm_mensagens_recebidas r2
  WHERE r2.telefone = r.telefone
)
-- já respondida (outbound enviado depois da recebida)
AND NOT EXISTS (
  SELECT 1
  FROM public.crm_mensagens_status s
  WHERE regexp_replace(coalesce(s.telefone_enviado, ''), '\D', '', 'g')
        = regexp_replace(r.telefone, '\D', '', 'g')
    AND s.evento_em > r.recebida_em
)
-- ou já com resposta AGENDADA (pendente/processando/enviada) depois da recebida
AND NOT EXISTS (
  SELECT 1
  FROM public.crm_mensagens_agendadas a
  WHERE regexp_replace(coalesce(a.telefone, ''), '\D', '', 'g')
        = regexp_replace(r.telefone, '\D', '', 'g')
    AND a.created_at > r.recebida_em
    AND a.status IN ('pendente', 'processando', 'enviada')
);
